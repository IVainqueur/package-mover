#!/usr/bin/env node
const path = require('path');
const {
    PackageList,
    isWindows,
    redText,
    getDependencies,
    resolveSubDependencies,
    getPackageLock,
    updatePackageJson,
    execProm,
    parseParams
} = require('../utils');

const { pmCopy } = require('./copy')

let params;

/**
 * @typedef {Object} StartParams
 * @property {String} source The relative or absolute path to the source directory
 * @property {String} destination The relative or absolute path to the destination directory
 * @property {String | String[]} packages An array of all the packages to transfer or string of space separated package names to be parsed into an array
 * @property {boolean} logErrors Whether or not to log verbose output
 * @property {boolean} alreadyParsed Whether or not the packages parameter has already been parsed
 */


/**
 * @param {StartParams} options 
 */
async function start(options) {
    console.time('duration:')
    params = parseParams(options ?? process.argv.slice(2));
    const packageLock = await getPackageLock(params.source, params)
    const packages = new PackageList();

    for (const pkg of params.packages) {
        packages.add((await getDependencies(pkg, params, packageLock, true)).values());
    }

    for (const package_name of packages.names()) {
        await resolveSubDependencies(package_name, packages, params, packageLock)
    }

    console.log("Copying", packages.size(), "packages...")

    await copyFolders(packages.names())
    await updatePackageJson(params, packages);
    console.timeEnd('duration:')
}

/**
 * 
 * @param {String[]} names an array of all package names to copy
 */
async function copyFolders(names) {
    /* 
    * Making an array of all packages found from the lock file plus the base packages specified at the start of the program
    * Then appending /node_modules or \node_modules for UNIX or Windows respectively
    * Then joining the array into on string to be used as part of the "copy_cmd" command
    */
    let package_names = params.packages.map(el => `${params.source}${isWindows() ? '\\' : '/'}node_modules/${el}`).join(' ') + ' ' + names.map(el => `${params.source}${isWindows() ? '\\' : '/'}node_modules/${el}`).join(' ')

    let foldercheck_cmd = ``
    let copy_cmd = ``;

    if (isWindows()) {
        foldercheck_cmd = `if not exist "${path.resolve(params.destination)}${isWindows() ? '\\' : '/'}node_modules" mkdir ${path.resolve(params.destination)}${isWindows() ? '\\' : '/'}node_modules`

    } else {
        foldercheck_cmd = `mkdir -p ${params.destination}${isWindows() ? '\\' : '/'}node_modules`
        copy_cmd = `rsync --ignore-missing-args -r ${package_names} ${params.destination}${isWindows() ? '\\' : '/'}node_modules`
    }

    try {
        await execProm(`${foldercheck_cmd}`);

        if (isWindows()) await pmCopy([params.destination, package_names]);
        else await execProm(`${copy_cmd}`);

    } catch (e) {
        redText(`[Error] Failed to copy the packages\nActual error: ${e.message}`)
        process.exit(1)
    }

}

module.exports.start = start