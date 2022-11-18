#!/usr/bin/env node
const commander = require('commander')
const { generatelock } = require('../src/utils')

const bootstrap = async () => {
    const program = commander;
    program.version(`\x1b[1mv${require('../package.json').version}\x1b[0m`, '-v, --version', 'Output the current version.')
        .usage('[path] [options...]')
        .helpOption('-h, --help', 'Output usage information.')
        .argument('<path>', 'destination path')

    commander.program.option('--yarn', 'Flag to generate yarn.lock instead of package-lock.json')
    commander.program.option('-f, --force', 'Override lock file if it already exists')
    program.parse()

    generatelock(commander.program.args[0], commander.program.opts())
}
bootstrap();