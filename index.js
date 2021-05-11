#!/usr/bin/env node

const master = require("./lib/kfwd_master");
const local = require("./lib/kfwd_local");
const yargs = require('yargs/yargs');

async function main() {
    const cmdLine = parseCmdLine();
    switch (parseMode(cmdLine)) {
        case "use-homedir-hosts":
            await master.run({ services: cmdLine.args, forceHomedirHosts: true, useEtcResolv: cmdLine['mount-resolve-conf'], namespace: cmdLine.namespace });
            break;
        case "use-etc-hosts":
            await master.run({ services: cmdLine.args, forceEtcHosts: true, useEtcResolv: cmdLine['mount-resolve-conf'], namespace: cmdLine.namespace });
            break;
        case "local":
            await local.run(JSON.parse(cmdLine.args[0]));
            break;
        default: // master
            await master.run({ services: cmdLine.args });
            break;
    }
}

function parseCmdLine() {
    return yargs(process.argv.slice(2)).usage('$0 [options] <args...>', 'forward dns names to cluster services', (yargs) => {
        yargs
            .example("kfwd svc1 svc2    ",
                "Starts kfwd in master mode, forwarding http requests made on this computer to to dns names 'svc1' and 'svc2' -> corresponding kubernetes cluster services. " +
                "After this you can open a new shell and do `curl http://svc1[:some port]` to talk to these services running in the cluster"
            )
            .example("kfwd alias1=svc1 alias2=svc2    ",
                "Starts kfwd in master mode, forwarding http requests made on this computer to to dns names 'alias1' and 'alias2' -> corresponding kubernetes cluster services svc1 and svc2. " +
                "After this you can open a new shell and do `curl http://svc1[:some port]` to talk to these services running in the cluster"
            )
            .option('use-etc-hosts', {
                alias: 'y',
                description: 'Will not ask if to edit /etc/hosts or ~/.hosts. /etc/hosts is automatically selected',
                type: 'boolean',
            })
            .option('mount-resolve-conf', {
                alias: 'm',
                description: 'Will mount /etc/resolve.conf into local proxy container',
                type: 'boolean',
                default: false
            })
            .option('namespace', {
                alias: 'n',
                description: 'Choose kubernetes namespaces instead of picking the current one',
                type: 'string',
            })
            .option('use-homedir-hosts', {
                alias: 'h',
                description: 'Will not ask if to edit /etc/hosts or ~/.hosts. ~/.hosts is automatically selected',
                type: 'boolean',
            })
            .option('local', {
                alias: 'l',
                description: 'Local docker kfwd mode - should not be used by end users of kfwd. Intended for master internally.',
                type: 'boolean',
            })
            .help()
            .strict()
    }).argv;
}


function parseMode(argv) {
    const possibleModes = ['master', 'use-etc-hosts', 'use-homedir-hosts', 'local'];
    for (const possibleMode of possibleModes) {
        if (argv[possibleMode]) {
            return possibleMode;
        }
    }
    return 'master';
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
