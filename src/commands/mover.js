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

// async function updatePackageJson() {
//     const source = JSON.parse(fs.readFileSync(`${params.source}/package.json`));
//     const destination = JSON.parse(fs.readFileSync(`${params.destination}/package.json`));

//     let updatedDeps = {};

//     for (const package of params.packages) {
//         const dep = source.dependencies?.[package]
//         const devDep = source.devDependencies?.[package]
//         const peerDep = source.devDependencies?.[package]
//         const optionalDep = source.devDependencies?.[package]

//         updatedDeps = {
//             ...updatedDeps,
//             dependencies: {
//                 ...(updatedDeps.dependencies ?? {}),
//                 ...(!!dep && { [package]: dep })
//             },
//             devDependencies: {
//                 ...(updatedDeps.devDependencies ?? {}),
//                 ...(!!devDep && { [package]: devDep })
//             },
//             peerDependencies: {
//                 ...(updatedDeps.peerDependencies ?? {}),
//                 ...(!!peerDep && { [package]: peerDep })
//             },
//             optionalDependencies: {
//                 ...(updatedDeps.optionalDependencies ?? {}),
//                 ...(!!optionalDep && { [package]: optionalDep })
//             }
//         }
//     }

//     destination.dependencies = {
//         ...destination?.dependencies,
//         ...updatedDeps.dependencies
//     }
//     destination.devDependencies = {
//         ...destination?.devDependencies,
//         ...updatedDeps.devDependencies
//     }
//     destination.peerDependencies = {
//         ...destination?.peerDependencies,
//         ...updatedDeps.peerDependencies
//     }
//     destination.optionalDependencies = {
//         ...destination?.optionalDependencies,
//         ...updatedDeps.optionalDependencies
//     }

//     fs.writeFileSync(`${params.destination}/package.json`, JSON.stringify(destination, null, 4))

//     // Updating package-lock.json
//     yellowText("Updating package-lock.json ...")
//     await execProm(`cd ${params.destination} && npm prune`)
//     greenText("package-lock.json updated!")

// }

async function copyFolders(names) {
    // Make the main directories
    let package_names = params.packages.map(el => `${params.source}/node_modules/${el}`).join(' ') + ' ' + names.map(el => `${params.source}/node_modules/${el}`).join(' ')

    let cmd = ``
    let cmd2 = ``;
    if (isWindows()) {
        cmd = `if not exist "${path.resolve(params.destination)}/node_modules mkdir ${path.resolve(params.destination)}/node_modules`
        cmd2 = `pm-copy ${params.destination} ${package_names}`
    } else {
        cmd = `mkdir -p ${params.destination}/node_modules`
        cmd2 = `rsync --ignore-missing-args -r ${package_names} ${params.destination}/node_modules`
    }

    try {
        await execProm(`${cmd} && ${cmd2}`);
    } catch (e) {
        redText(`[Error] Failed to copy the packages\nActual error: ${e.message}`)
        process.exit(1)
    }

}

module.exports.start = start