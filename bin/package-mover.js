#!/usr/bin/env node
const commander = require('commander')
const { start } = require('../src/commands/command1')
const bootstrap = async () => {
    const program = commander;
    program.version(require('../package.json').version, '-v, --version', 'Output the current version.')
        .usage('[options]')
        .helpOption('-h, --help', 'Output usage information.');

    commander.program.requiredOption('-s, --source <value>', 'Source')
    commander.program.requiredOption('-d, --destination <value>', 'Destination')
    commander.program.requiredOption('-p, --packages <value...>', 'Packages')
    commander.program.option('-l, --logErrors', 'logErrors')



    program.parse()

    await start({
        ...commander.program.opts(),
        alreadyParsed: true
    })
}
bootstrap();