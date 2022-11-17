#!/usr/bin/env node
/**
 * @typedef {Array} CopyParams
 * @property {String} destination The path to where the packages are going to be copied
 * @property {String[]} sources An array of paths to copy to the `destination`
 */

const { exec } = require('child_process')
const path = require('path')
const { isWindows } = require('../utils')

/**
 * @param {CopyParams} options
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