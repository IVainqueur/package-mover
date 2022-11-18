#!/usr/bin/env node
const fs = require('fs')
const path = require('path');
const {
    Params,
    PackageList,
    isWindows,
    redText,
    getDependencies,
    resolveSubDependencies,
    getPackageLock,
    updatePackageJson,
    execProm
} = require('../utils');

const { pmCopy } = require('./copy')

let params;

function parseParams(args) {
    if (args.alreadyParsed) return new Params(args.packages, args.source, args.destination, args.logErrors)
    const p = new Params();
    for (let arg of args) {
        const [key, value] = arg.split("=");
        if (Params.args.get(key)) p[Params.args.get(key)] = value;
    }
    for (const param of ["source", "destination", "packages"]) {
        if (!!p[param]) continue;
        redText(`[error] missing --${param} parameter`) // Logging error
        process.exit(1);
    }
    // formatting
    p.packages = p.packages.split(',')
    return p;
}


/**
 * @typedef {Object} StartParams
 * @property {String} source
 * @property {String} destination
 * @property {String} packages
 * @property {boolean} logErrors
 * @property {boolean} alreadyParsed
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

async function copyFolders(names) {
    // Make the main directories
    let package_names = params.packages.map(el => `${params.source}${isWindows() ? '\\' : '/'}node_modules/${el}`).join(' ') + ' ' + names.map(el => `${params.source}${isWindows() ? '\\' : '/'}node_modules/${el}`).join(' ')

    let cmd = ``
    let cmd2 = ``;
    if (isWindows()) {
        cmd = `if not exist "${path.resolve(params.destination)}${isWindows() ? '\\' : '/'}node_modules" mkdir ${path.resolve(params.destination)}${isWindows() ? '\\' : '/'}node_modules`
        await pmCopy([params.destination, package_names])
    } else {
        cmd = `mkdir -p ${params.destination}${isWindows() ? '\\' : '/'}node_modules`
        cmd2 = `rsync --ignore-missing-args -r ${package_names} ${params.destination}${isWindows() ? '\\' : '/'}node_modules`
    }

    try {
        await execProm(`${cmd}`);
        if(!isWindows()) await execProm(`${cmd2}`);
    } catch (e) {
        redText(`[Error] Failed to copy the packages\nActual error: ${e.message}`)
        process.exit(1)
    }

}

module.exports.start = start