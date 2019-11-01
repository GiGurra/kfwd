
const childProc = require('child_process');

module.exports = {

    /**
     * @param conf: [ { from: 1234, to: { port: 9000, pod: the-pod } } ]
     */
    run: async function (conf) {

        process.on('SIGINT', () => { process.exit(0) });

        console.log("runLocal with " + JSON.stringify(conf));

        for (const rule of conf) {

            const listenPort = rule.from;
            const targetPod = rule.to.pod;
            const targetPort = rule.to.port;
            const namespace = rule.to.namespace;

            console.log("proxying local traffic on port " + listenPort + " to pod " + targetPod + " on port " + targetPort);
            const portForwardProc = childProc.spawn("kubectl", ["-n", namespace, "port-forward", "--address", "0.0.0.0", targetPod, listenPort + ":" + targetPort], {stdio: ['ignore', 'inherit', 'inherit']});
            portForwardProc.on('exit', (code) => {
                console.error("kubectl port-forward-process " + listenPort + " -> " + targetPod + ":" + targetPort + " terminated unexpectedly with error code " + code);
                // Replace with reconnect logic, at some point.. in the meantime this is needed to abort on first pod failure,
                // otherwise we will keep running until all connections fail, which may never happen.
                process.exit(1);
            });
        }
    }
};
