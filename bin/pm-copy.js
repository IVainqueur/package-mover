#!/usr/bin/env node
const commander = require('commander')
const { start } = require('../src/commands/copy')
const bootstrap = async () => {
    const program = commander;
    program.version(`\x1b[1mv${require('../package.json').version}\x1b[0m`, '-v, --version', 'Output the current version.')
        .usage('[destination] [sources...]')
        .helpOption('-h, --help', 'Output usage information.')
        .argument('<destination>', 'destination path')
        .argument('<sources...>', 'space separated arrays of sources to copy');

    program.parse()

    start(commander.program.args)
}
bootstrap();