
const childProc = require('child_process');
const yaml = require('js-yaml');
const os = require('os');
const tableParser = require('table-parser');
const readlineSync = require('readline-sync'); // see https://www.npmjs.com/package/readline-sync for documentation on how to use it
const fs = require('fs');

const kfwdDockerImage = "gigurra/kfwd:1.0.0";

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

    process.on('SIGINT', () => { globalState.cleanup(); process.exit(0) });

    const updateEtcHosts = conf.forceEtcHosts || (!conf.forceHomedirHosts && readlineSync.keyInYN(
        'kfwd can automatically add entries to /etc/hosts for kubernetes services\n' +
        'Do you want kfwd to do this? (no: ~/.hosts will be written instead)'
    ));

    if (updateEtcHosts && !checkEtcHostsWritable()) {
        console.error("In order to create hostname aliases, kfwd needs write permissions to /etc/hosts, which the current user doesn't have. Aborting!");
        process.exit(1);
    }

    console.log("Setting up proxies and dns aliases to forward traffic to services: " + conf.services);

    let nextPort = 2000;
    function assignJumpPort(obj) {
        obj.jumpPort = nextPort;
        nextPort = nextPort + 1;
        return obj
    }

    const jumpPodArgs = [];
    const serviceConfigs = [];
    for (const serviceName of conf.services) {
        const rawConf = yaml.safeLoad(childProc.execSync("kubectl get service " + serviceName + " -o yaml").toString());
        const conf = {
            serviceName: serviceName,
            ports: rawConf.spec.ports.map(v => assignJumpPort(v))
        };
        serviceConfigs.push(conf);
        for (const port of conf.ports) {
            jumpPodArgs.push({
                from: port.jumpPort,
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

    const cmd = "kubectl run " + jumpPodName +
        " --image tecnativa/tcp-proxy:v1.0.1 " +
        " --env TALK='" + proxyTalk + "'" +
        " --env LISTEN='" + proxyListen + "'" +
        " --pod-running-timeout 1m " +
        " --generator=run-pod/v1";

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
                    pod: jumpPodName,
                    port: pcfg.jumpPort
                }
            }
        });


        const localJumperName = "kfwd--" + serviceConfig.serviceName + "--" + globalState.appInstanceId;
        console.log(" -> Starting local jump container '" + localJumperName + "'");
        const dockerChildProc = childProc.spawn("docker", [
            "run", "--rm", "--init",
            "-v", "/etc/resolv.conf:/etc/resolv.conf:ro",
            "-v", homedir + "/.kube/config:/root/.kube/config",
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
            serviceName: serviceConfig.serviceName
        });
    }

    const hostsFile = updateEtcHosts ? "/etc/hosts" : (homedir + "/.hosts");
    globalState.hostsFile = hostsFile;

    console.log();
    console.log("Updating '" + hostsFile + "'");

    globalState.generatedLineSuffix = " # kfwd AUTO GENERATED ALIAS, kfwd instance id: " + globalState.appInstanceId;

    for (const spawnedHost of spawnedHosts) {
        const cmd =  updateEtcHosts ?
            ("echo '" + spawnedHost.localIp + " " + spawnedHost.serviceName + globalState.generatedLineSuffix + "' |  tee -a " + hostsFile) :
            ("echo '" + spawnedHost.serviceName + " " + spawnedHost.localIp + ".xip.io" + globalState.generatedLineSuffix + "' |  tee -a " + hostsFile);
        console.log(" -> adding " + spawnedHost.localIp + " " + spawnedHost.serviceName + " to " + hostsFile);
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

            const currentPodState = yaml.safeLoad(childProc.execSync("kubectl get pod " + hookPodName + " -o yaml"));

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
