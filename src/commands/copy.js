#!/usr/bin/env node
const { exec } = require('child_process')
const path = require('path')
const { isWindows } = require('../utils')

/**
 * @param {String[]} options
 */
const start = (options) => {
    if(!isWindows()) process.exit(0);
    if(options.length < 2) process.exit(0);
    const destination = options[0];
    const sources = options.slice(1);

    const cmd = `${path.join(__dirname, '../../pm-copy.bat')} ${sources.join(' ')} ${destination}`;
    exec(cmd)
}

module.exports.start = start