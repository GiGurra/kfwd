
const uuidv4 = require('uuid/v4');

const childProc = require('child_process');
const tableParser = require('table-parser');

module.exports = {

    jumpPodName: null,
    jumpPodStarted: false,
    generatedLineSuffix: null,
    appInstanceId: uuidv4(),
    hostsFile: null,

    cleanup: function () {

        try {
            if (this.hostsFile) {
                console.log("cleaning up entries in " + this.hostsFile);
                const cmd = "sed -i '/" + this.generatedLineSuffix + "/d' " + this.hostsFile;
                childProc.execSync(cmd);
            }
        } catch (error) {
            console.error("cleanup of " + this.hostsFile + " failed with error: " + error);
        }

        try {

            const containersDiedOnTheirOwn = waitForSpawnedContainersToDieOnTheirOwn(this.appInstanceId);

            if (!containersDiedOnTheirOwn) {

                console.log("Forcibly killing remaining local containers...");

                const containersToKill =
                    tableParser
                        .parse(childProc.execSync("docker ps").toString())
                        .map(toContainerName)
                        .filter(n => n.includes(appInstanceId));

                for (const containerToKill of containersToKill) {
                    try {
                        childProc.execSync("docker kill " + containerToKill);
                        console.log("stopped local container " + containerToKill)
                    } catch (error) {
                        console.error("Failed stopping local container " + containerToKill + " due to: " + error);
                    }
                }

            }
        } catch (error) {
            console.error("cleanup local docker containers failed with error: " + error);
        }

        try {
            if (this.jumpPodStarted) {
                console.log("deleting remote/cluster jump pod " + this.jumpPodName);
                childProc.execSync("kubectl delete pod " + this.jumpPodName + " --wait=false")
            }
        } catch (error) {
            console.error("cleanup of remote/cluster jump pods failed with error: " + error);
        }

    }


};


function waitForSpawnedContainersToDieOnTheirOwn(appInstanceId) {

    const maxMillis = 10000;
    const interval = 500;
    const maxAttempts = maxMillis / interval;

    let iAttempt = 0;
    let success = false;

    while (!success && iAttempt < maxAttempts) {

        console.log("Waiting up to 10 seconds for spawned containers to die on their own...");

        const containersToKill =
            tableParser
                .parse(childProc.execSync("docker ps").toString())
                .map(toContainerName)
                .filter(n => n.includes(appInstanceId));

        success = containersToKill.length === 0;

        if (!success) {
            childProc.execSync("sleep 1"); // unfortunately cannot do async in this function, as it is called from sigint handler.
        }

        iAttempt = iAttempt + 1
    }

    return success;
}

function toContainerName(tableResource) {
    return tableResource.NAMES.toString();
}

