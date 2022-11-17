#!/usr/bin/env node
const commander = require('commander')
const { start } = require('../src/commands/command1')
const bootstrap = async () => {
    const program = commander;
    program.version(`\x1b[1mv${require('../package.json').version}\x1b[0m`, '-v, --version', 'Output the current version.')
        .usage('[options]')
        .helpOption('-h, --help', 'Output usage information.');

    commander.program.requiredOption('-s, --source <value>', 'Source folder. Can be absolute or relative path')
    commander.program.requiredOption('-d, --destination <value>', 'Destination folder. Can be absolute or relative path')
    commander.program.requiredOption('-p, --packages <value...>', 'The package(s) that you want to transfer')
    commander.program.option('-l, --logErrors', 'For logging errors. default `false`')



    program.parse()

    await start({
        ...commander.program.opts(),
        alreadyParsed: true
    })
}
bootstrap();