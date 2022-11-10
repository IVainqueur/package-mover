#!/usr/bin/env node
const fs = require('fs')
const { exec } = require('child_process')

const { Params, PackageList, isWindows, redText, yellowText, greenText } = require('../utils')

let params;

function parseParams(args) {
    if(args.alreadyParsed) return new Params(args.packages, args.source, args.destination, args.logErrors)
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

async function getDependencies(package) {
    let packages = new PackageList();
    try {
        let {
            dependencies,
            devDependencies,
            peerDependencies,
            optionalDependencies
        } = JSON.parse(fs.readFileSync(`${params.source}/node_modules/${package}/package.json`));

        packages.add(
            [
                ...((dependencies && Object.keys(dependencies).map(el => ({ name: el, category: "dependencies" }))) ?? []),
                ...((devDependencies && Object.keys(devDependencies).map(el => ({ name: el, category: "devDependencies" }))) ?? []),
                ...((peerDependencies && Object.keys(peerDependencies).map(el => ({ name: el, category: "peerDependencies" }))) ?? []),
                ...((optionalDependencies && Object.keys(optionalDependencies).map(el => ({ name: el, category: "optionalDependencies" }))) ?? [])
            ]
        )

    } catch (e) {
        if (params.logErrors) redText("[Error] Failed to resolve :", package);
    }
    return packages;
}

/**
 * @typedef {Object} Params
 * @property {String} source
 * @property {String} destination
 * @property {String} packages
 * @property {boolean} logErrors
 * @property {boolean} alreadyParsed
 */

/**
 * @param {Params} options 
 */
async function start(options) {
    
    params = parseParams(options ?? process.argv.slice(2));
    const packages = new PackageList();
    for (const pkg of params.packages) {
        packages.add((await getDependencies(pkg)).values());
    }
    for (const package_name of packages.names()) {
        await resolveSubDependencies(package_name, packages)
    }

    console.log("Copying", packages.size(), "packages...")

    copyFolders(packages.names())
    updatePackageJson()
}

async function resolveSubDependencies(package, mainPackages) {
    const subpackages = await getDependencies(package);
    for (const subpackage of subpackages.values()) {
        if (!mainPackages.contains(subpackage.name)) {
            mainPackages.add(subpackage)
            await resolveSubDependencies(subpackage.name, mainPackages);
        }
        mainPackages.add(subpackage)
    }
}

async function updatePackageJson() {
    const source = JSON.parse(fs.readFileSync(`${params.source}/package.json`));
    const destination = JSON.parse(fs.readFileSync(`${params.destination}/package.json`));

    let updatedDeps = {};

    for (const package of params.packages) {
        const dep = source.dependencies?.[package]
        const devDep = source.devDependencies?.[package]
        const peerDep = source.devDependencies?.[package]
        const optionalDep = source.devDependencies?.[package]

        updatedDeps = {
            ...updatedDeps,
            dependencies: {
                ...(updatedDeps.dependencies ?? {}),
                ...(!!dep && { [package]: dep })
            },
            devDependencies: {
                ...(updatedDeps.devDependencies ?? {}),
                ...(!!devDep && { [package]: devDep })
            },
            peerDependencies: {
                ...(updatedDeps.peerDependencies ?? {}),
                ...(!!peerDep && { [package]: peerDep })
            },
            optionalDependencies: {
                ...(updatedDeps.optionalDependencies ?? {}),
                ...(!!optionalDep && { [package]: optionalDep })
            }
        }
    }

    destination.dependencies = {
        ...destination?.dependencies,
        ...updatedDeps.dependencies
    }
    destination.devDependencies = {
        ...destination?.devDependencies,
        ...updatedDeps.devDependencies
    }
    destination.peerDependencies = {
        ...destination?.peerDependencies,
        ...updatedDeps.peerDependencies
    }
    destination.optionalDependencies = {
        ...destination?.optionalDependencies,
        ...updatedDeps.optionalDependencies
    }

    fs.writeFileSync(`${params.destination}/package.json`, JSON.stringify(destination, null, 4))

    // Updating package-lock.json
    yellowText("Updating package-lock.json ...")
    await exec(`cd ${params.destination} && npm prune`)
    greenText("package-lock.json updated!")

}

async function copyFolders(names) {
    // Make the main directories
    let package_names = params.packages.map(el => `${params.source}/node_modules/${el}`).join(' ') + ' ' + names.map(el => `${params.source}/node_modules/${el}`).join(' ')

    const cmd = `mkdir -p ${params.destination}/node_modules`
    const cmd2 = `${isWindows() ? 'copy /Y' : 'rsync --ignore-missing-args -r'}  ${package_names} ${params.destination}/node_modules`

    exec(`${cmd} && ${cmd2}`);

}

module.exports.start = start