#!/usr/bin/env node
const fs = require('fs')
const { exec } = require('child_process')

const { Params, PackageList, isWindows } = require('../src/utils')

const params = parseParams(process.argv.slice(2))

function parseParams(args) {
    const p = new Params();
    for (let arg of args) {
        const [key, value] = arg.split("=");
        if (Params.args.get(key)) p[Params.args.get(key)] = value;
    }
    for (const param of ["source", "destination", "packages"]) {
        if (!!p[param]) continue;
        console.log(`[error] missing --${param} parameter`)
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
            peerDependencies
        } = JSON.parse(fs.readFileSync(`${params.source}/node_modules/${package}/package.json`));

        packages.add(
            [
                ...((dependencies && Object.keys(dependencies).map(el => ({ name: el, category: "dependencies" }))) ?? []),
                ...((devDependencies && Object.keys(devDependencies).map(el => ({ name: el, category: "devDependencies" }))) ?? []),
                ...((peerDependencies && Object.keys(peerDependencies).map(el => ({ name: el, category: "peerDependencies" }))) ?? [])
            ]
        )

    } catch (e) {
        if (params.logErrors) console.log("[Error] Failed to resolve :", package);
    }
    return packages;
}



async function start() {
    console.log(params.packages);
    const packages = new PackageList();
    for (const pkg of params.packages) {
        packages.add((await getDependencies(pkg)).values());
    }
    for (const package_name of packages.names()) {
        await resolveSubDependencies(package_name, packages)
    }

    //copy the found modules
    copyFolders(packages.names())
    // Update the destination package.json
    updatePackageJson()
    console.log(
        // packages.names(),
        packages.size()
    );

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


    // console.log(destination)
    fs.writeFileSync(`${params.destination}/package.json`, JSON.stringify(destination, null, 4))

}


async function copyFolders(names) {
    // Make the main directories
    let package_names = params.packages.map(el => `${params.source}/node_modules/${el}`).join(' ') + ' ' + names.map(el => `${params.source}/node_modules/${el}`).join(' ')

    const cmd = `mkdir -p ${params.destination}/node_modules`
    const cmd2 = `${isWindows() ? 'copy /Y' : 'rsync --ignore-missing-args -r'}  ${package_names} ${params.destination}/node_modules`

    exec(`${cmd} && ${cmd2}`);

}

start()