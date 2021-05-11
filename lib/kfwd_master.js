
const childProc = require('child_process');
const yaml = require('js-yaml');
const os = require('os');
const tableParser = require('table-parser');
const readlineSync = require('readline-sync'); // see https://www.npmjs.com/package/readline-sync for documentation on how to use it
const fs = require('fs');

const kfwdDockerImage = "gigurra/kfwd:1.0.1";
const commandExists = require('command-exists');

const globalState = require("./kfwd_masterglobals");

module.exports = {
    run: async function(conf) {
        return await runMaster(conf).catch(error => {
            console.error(error);
            globalState.cleanup();
            process.exit(1);
        });
    }
};

async function runMaster(conf) {

    if (!commandExists.sync("kubectl")) {
        console.error("You need to have kubectl on path for this to work");
        process.exit(1);
    }

    if (!commandExists.sync("sed")) {
        console.error("You need to have sed on path for this to work");
        process.exit(1);
    }

    if (!commandExists.sync("docker")) {
        console.error("You need to have docker on path for this to work");
        process.exit(1);
    }

    if (!commandExists.sync("tee")) {
        console.error("You need to have tee on path for this to work");
        process.exit(1);
    }

    process.on('SIGINT', () => { globalState.cleanup(); process.exit(0) });

    const updateEtcHosts = conf.forceEtcHosts || (!conf.forceHomedirHosts && readlineSync.keyInYN(
        'kfwd can automatically add entries to /etc/hosts for kubernetes services\n' +
        'Do you want kfwd to do this? (no: ~/.hosts will be written instead)'
    ));

    if (updateEtcHosts && !checkEtcHostsWritable()) {
        console.error("In order to create hostname aliases, kfwd needs write permissions to /etc/hosts, which the current user doesn't have. Aborting!");
        process.exit(1);
    }

    globalState.namespace = conf.namespace || getCurrentNamespace();

    console.log("Setting up proxies and dns aliases to forward traffic to services: " + conf.services + ", namespace=" + globalState.namespace);

    let nextPort = 2000;
    function assignJumpPort(obj) {
        obj.jumpPort = nextPort;
        nextPort = nextPort + 1;
        return obj
    }

    const jumpPodArgs = [];
    const serviceConfigs = [];
    for (const serviceRoute of conf.services) {
        const routeParts = serviceRoute.split('=');
        if (routeParts.length > 2) {
            throw new Error(("Malformed service route: " + serviceRoute))
        }
        const serviceName = (routeParts.length === 2) ? routeParts[1] : serviceRoute;
        const serviceAlias = (routeParts.length === 2) ? routeParts[0] : null;

        const rawConf = yaml.safeLoad(childProc.execSync("kubectl -n " + globalState.namespace + " get service " + serviceName + " -o yaml").toString());
        const conf = {
            serviceName: serviceName,
            serviceAlias: serviceAlias,
            ports: rawConf.spec.ports.map(v => assignJumpPort(v))
        };
        serviceConfigs.push(conf);
        for (const port of conf.ports) {
            jumpPodArgs.push({
                from: port.jumpPort,
                serviceAlias: serviceAlias,
                to: {
                    host: serviceName,
                    port: port.port
                }
            })
        }
    }

    // Spawn jump pod
    const jumpPodName = "kfwd--jump-pod--" + globalState.appInstanceId;
    globalState.jumpPodName = jumpPodName;

    console.log();
    console.log("Spawning kfwd jump pod: " + jumpPodName);

    const proxyTalk = jumpPodArgs.map(a => a.to.host + ":" + a.to.port).join(" ");
    const proxyListen = jumpPodArgs.map(a => ":" + a.from).join(" ");

    const cmd = "kubectl -n " + globalState.namespace + " run " + jumpPodName +
        " --image tecnativa/tcp-proxy:v1.0.1 " +
        " --env TALK='" + proxyTalk + "'" +
        " --env LISTEN='" + proxyListen + "'" +
        " --pod-running-timeout 1m " ;

    childProc.execSync(cmd);

    globalState.jumpPodStarted = true;

    // Wait for hook pod to reach state running in kubernetes
    await waitForPodToReachStateRunning(jumpPodName);
    console.log(" -> kfwd jump pod started successfully!");

    // Wait for docker to pull the required jumpContainer image
    console.log();
    console.log("Pulling kfwd docker image used for creating local proxies..");
    childProc.execSync("docker pull " + kfwdDockerImage, {stdio: 'inherit'});

    console.log();
    console.log("Starting local jump containers...");
    const homedir = os.homedir();
    const spawnedHosts = [];
    for (const serviceConfig of serviceConfigs) {

        const portCfg = serviceConfig.ports.map(pcfg => {
            return {
                from: pcfg.port,
                to: {
                    namespace: globalState.namespace,
                    pod: jumpPodName,
                    port: pcfg.jumpPort
                }
            }
        });

        const kubeConfFile = process.env.KUBECONFIG || (homedir + "/.kube/config");
        const useEtcResolve = conf.useEtcResolv;

        console.log(`Mounting /etc/resolv.conf: ${useEtcResolve}`);

        const localJumperName = "kfwd--" + serviceConfig.serviceName + "--" + globalState.appInstanceId;
        console.log(" -> Starting local jump container '" + localJumperName + "'");
        const dockerChildProc = childProc.spawn("docker", [
            "run", "--rm", "--init",
            "-v", `/etc/resolv.conf:/etc/resolv.conf${useEtcResolve ?  '' : '.not-used' }:ro`,
            "-v", kubeConfFile + ":/root/.kube/config",
            "--name", localJumperName,
            kfwdDockerImage, "--local", JSON.stringify(portCfg)
        ], {stdio: ['pipe', 'ignore', 'inherit']});
        dockerChildProc.on('exit', (code) => {
            console.error("docker run terminated unexpectedly with error code " + code + ", container: " + localJumperName);
            // Replace with reconnect logic, at some point.. in the meantime this is needed to abort on first pod failure,
            // otherwise we will keep running until all connections fail, which may never happen.
            globalState.cleanup();
            process.exit(1);
        });

        await waitForLocalJumperToComeUp(localJumperName);

        const containerInspectData = JSON.parse(childProc.execSync("docker inspect " + localJumperName).toString())[0];
        const localIpAddress = containerInspectData.NetworkSettings.IPAddress;

        spawnedHosts.push({
            localIp: localIpAddress,
            localContainerName: localJumperName,
            serviceName: serviceConfig.serviceName,
            localName: serviceConfig.serviceAlias || serviceConfig.serviceName,
        });
    }

    const hostsFile = updateEtcHosts ? "/etc/hosts" : (homedir + "/.hosts");
    globalState.hostsFile = hostsFile;

    console.log();
    console.log("Updating '" + hostsFile + "'");

    globalState.generatedLineSuffix = " # kfwd AUTO GENERATED ALIAS, kfwd instance id: " + globalState.appInstanceId;

    for (const spawnedHost of spawnedHosts) {
        const cmd =  updateEtcHosts ?
            ("echo '" + spawnedHost.localIp + " " + spawnedHost.localName + globalState.generatedLineSuffix + "' |  tee -a " + hostsFile) :
            ("echo '" + spawnedHost.localName + " " + spawnedHost.localIp + ".xip.io" + globalState.generatedLineSuffix + "' |  tee -a " + hostsFile);
        console.log(" -> adding " + spawnedHost.localIp + " " + spawnedHost.localName + " to " + hostsFile);
        childProc.execSync(cmd);
    }

    if (!updateEtcHosts) {
        console.log(
            "=====================================================================================================\n" +
            "=====================================================================================================\n" +
            "   UPDATED " + hostsFile + ". Remember to do 'export HOSTALIASES=" + hostsFile + "'\n" +
            "=====================================================================================================\n"
        );
    }

    console.log("kfwd now running. Hit ctl+c/sigint to shut down");
    await new Promise(done => setTimeout(done, 2000000000));
}

async function waitForPodToReachStateRunning(hookPodName) {

    const success = await waitFor(
        async () => {

            const currentPodState = yaml.safeLoad(childProc.execSync("kubectl -n " + globalState.namespace + " get pod " + hookPodName + " -o yaml"));

            return currentPodState &&
                currentPodState.status &&
                currentPodState.status.containerStatuses &&
                currentPodState.status.containerStatuses[0] &&
                currentPodState.status.containerStatuses[0].state &&
                currentPodState.status.containerStatuses[0].state.running &&
                currentPodState.status.containerStatuses[0].state.running.startedAt

        },
        60000,
        500,
        "Waiting for hook pod '" + hookPodName + "' to reach state Running ..."
    );

    if (!success) {
        throw new Error("Hook pod never reached running state")
    }
}

async function waitForLocalJumperToComeUp(jumper) {

    const success = await waitFor(
        async () => {

            const allContainerNames =
                tableParser
                    .parse(childProc.execSync("docker ps").toString())
                    .map(toContainerName);

            return allContainerNames.indexOf(jumper) > -1;

        },
        60000,
        500,
        "Waiting for '" + jumper + "' to come up ..."
    );

    if (!success) {
        throw new Error("Local jumper " + jumper + " never came up!")
    }
}

function checkEtcHostsWritable() {
    try {
        fs.accessSync("/etc/hosts", fs.constants.W_OK);
        return true;
    } catch (error) {
        return false;
    }
}

function getCurrentNamespace() {
    return childProc.execSync("kubectl config view --minify --output 'jsonpath={..namespace}'")
        .toString()
        .trim();
}

function toContainerName(tableResource) {
    return tableResource['NAMES'].toString();
}

async function waitFor(test, maxMillis, interval, message) {

    let iAttempt = 0;
    let maxAttempts = maxMillis / interval;
    let success = false;

    while (!success && iAttempt < maxAttempts) {

        if (message) {
            console.log(message);
        }

        success = await test();

        if (!success) {
            await new Promise(done => setTimeout(done, interval));
        }

        iAttempt = iAttempt + 1
    }

    return success
}

