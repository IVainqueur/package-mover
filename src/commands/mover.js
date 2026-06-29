#!/usr/bin/env node
const path = require('path');
const {
    PackageList,
    isWindows,
    redText,
    getPackageLock,
    updatePackageJson,
    parseParams,
    resolveAllDependencies,
    copyPackagesParallel,
    DEFAULT_CONCURRENCY,
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

    // Parallel primary + iterative BFS transitive resolution (replaces sequential for-loops)
    await resolveAllDependencies(params.packages, packages, params, packageLock, DEFAULT_CONCURRENCY);

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
    // Deduplicate primary + resolved names once
    const allNames = [...new Set([...params.packages, ...names])];

    try {
        if (isWindows()) {
            // Windows: keep bat path for compatibility, but feed unique paths only
            const package_names = allNames
                .map(el => `${params.source}\\node_modules\\${el}`)
                .join(' ');
            const foldercheck_cmd = `if not exist "${path.resolve(params.destination)}\\node_modules" mkdir ${path.resolve(params.destination)}\\node_modules`;
            const { execProm } = require('../utils');
            await execProm(`${foldercheck_cmd}`);
            await pmCopy([params.destination, package_names]);
        } else {
            // Unix: Node-native parallel copy — avoids rsync overhead on many small files
            await copyPackagesParallel(params.source, params.destination, allNames, DEFAULT_CONCURRENCY);
        }
    } catch (e) {
        redText(`[Error] Failed to copy the packages\nActual error: ${e.message}`)
        process.exit(1)
    }
}

module.exports.start = start
