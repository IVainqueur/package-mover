#!/usr/bin/env node
const path = require('path')
const { isWindows, execProm } = require('../utils')

/**
 * @param {String[]} options
 */
const start = async (options) => {
    if(!isWindows()) process.exit(0);
    if(options.length < 2) process.exit(0);
    const destination = options[0];
    const sources = options.slice(1);

    const cmd = `${path.join(__dirname, '../../pm-copy.bat')} ${sources.join(' ')} ${destination}`;
    try{
        await execProm(cmd)
    }catch(e){
        console.log(e)
    }
}

module.exports.start = start
module.exports.pmCopy = start