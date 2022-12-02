const { resolve: resolvePath, join: joinPath } = require('path')
const fs = require('fs');
const { exec } = require('child_process');

class Params {
    source = "./";
    destination = null;
    logErrors = false;
    packages = []

    static args = new Map([
        ['--source', 'source'],
        ['--destination', 'destination'],
        ['--logErrors', 'logErrors'],
        ['--packages', 'packages'],
        ['--legacy', 'legacy'],
        ['--forceLock', 'forceLock']
    ])

    static dependencyTypes = [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
    ];

    constructor(packages, source, destination, logErrors) {
        [this.source, this.destination, this.packages, this.logErrors] = [source, destination, packages, logErrors];
    }
}

class PackageList {
    list = [];
    constructor(init) {
        if (init === undefined) return;
        if (!Array.isArray(init)) throw new Error("PackageList constructor receives array of initial values")
        init.map(el => this.add(el));
    }
    names() {
        return this.list.map(el => el.name);
    }
    values() {
        return this.list;
    }
    content(prefix = '') {
        return this.list.map(el => ({ [prefix + el.name]: (el.content ?? {}) }))
    }
    versions() {
        return this.list.map(el => ({ [el.name]: el.content?.version ?? "1.0.0" }))
    }
    primary() {
        return this.list.filter(({ isPrimary }) => isPrimary)
    }
    primary_versions() {
        return this.list.filter(({ isPrimary }) => isPrimary).map(el => ({ [el.name]: '^' + el.content?.version ?? "1.0.0" }))
    }
    add(val) {
        if (!Array.isArray(val)) val = [val]
        const names = this.names();
        val.map(el => {
            if (names.includes(el.name)) return;
            this.list.push(el);
        })

        return this.list
    }

    contains(val) {
        return this.list.map(el => el.name).includes(val);
    }
    size() {
        return this.list.length;
    }
}

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


function isWindows() {
    return !!process.platform.match('win32')
}

function redText(...args) {
    console.log("\x1b[031m", ...args, "\x1b[0m");
}

function greenText(...args) {
    console.log("\x1b[032m", ...args, "\x1b[0m");
}

function yellowText(...args) {
    console.log("\x1b[033m", ...args, "\x1b[0m");
}

async function getDependencies(package, params, packageLock, isPrimary) {
    let packages = new PackageList();
    const package_key = params.legacy ? package : `node_modules/${package}`
    const depTypes = isPrimary ? Params.dependencyTypes : [params.legacy ? 'dependencies' : 'packages']

    try {

        let packageInfo = !!!packageLock
            ?
            JSON.parse(fs.readFileSync(`${params.source}${isWindows() ? '\\' : '/'}node_modules/${package}/package.json`))
            :
            packageLock[params.legacy ? 'dependencies' : 'packages'][package_key] ?? {};

        if (Object.keys(packageInfo).length == 0) return packages

        //* Adding the current package first
        packages.add([
            {
                name: package,
                isPrimary,
                content: packageLock[params.legacy ? 'dependencies' : 'packages'][package_key] ?? {}
            }
        ])

        for (let dependencyType of depTypes) {
            packages.add(
                [
                    ...(
                        (
                            packageInfo[dependencyType] &&
                            Object.keys(packageInfo[dependencyType]).map(el => {
                                const _el = params.legacy ? el : `node_modules/${el}`
                                return ({
                                    name: el,
                                    content: packageLock[params.legacy ? 'dependencies' : 'packages'][_el] ?? {}
                                })
                            })
                        )
                        ??
                        []
                    )
                ]
            )
        }


    } catch (e) {
        if (params.logErrors) redText("[Error] Failed to resolve :", package);
        console.log(e)
    }
    if (params.logErrors) console.log(`[${package}] depends on`, packages.size(), 'packages')
    return packages;
}


async function resolveSubDependencies(package, mainPackages, params, package_lock) {
    const subpackages = await getDependencies(package, params, package_lock);
    for (const subpackage of subpackages.values()) {
        if (!mainPackages.contains(subpackage.name)) {
            await resolveSubDependencies(subpackage.name, mainPackages, params, package_lock);
        }
        mainPackages.add(subpackage)
    }
}

async function getPackageLock(src, params) {
    const src_packagelock_fullpath = joinPath(resolvePath(src), './package-lock.json');
    try {
        return JSON.parse(fs.readFileSync(src_packagelock_fullpath))
    } catch (e) {
        if (params?.logErrors) redText('[Error] Failed to read the package-lock')
        return {}
    }
}

/**
 * This function runs the child_process.exec command in a promise 
 * this allows the use of `await` and .then blocks instead of having to use a callback function
 * @param {String} command The command to run
 * @returns 
 */
function execProm(command) {
    return new Promise((resolve, reject) => {
        exec(command, (err, stdout, stderr) => {
            if (err) reject(err)
            if (stderr) reject(stderr)
            resolve(stdout)
        })
    })
}

async function updatePackageJson(params, packages) {
    const source = JSON.parse(fs.readFileSync(`${params.source}/package.json`));
    const destination = JSON.parse(fs.readFileSync(`${params.destination}/package.json`));

    let updatedDeps = {};

    for (const package of params.packages) {
        for (const dependencyType of Params.dependencyTypes) {
            const arr = source[dependencyType]?.[package]
            updatedDeps = {
                ...updatedDeps,
                [dependencyType]: {
                    ...(updatedDeps[dependencyType] ?? {}),
                    ...(!!arr && { [package]: arr })
                }
            }
        }

    }


    for (const dependencyType of Params.dependencyTypes) {
        destination[dependencyType] = {
            ...(destination[dependencyType] ?? {}),
            ...updatedDeps[dependencyType]
        }
    }

    fs.writeFileSync(`${params.destination}/package.json`, JSON.stringify(destination, null, 4))

    // Updating package-lock.json
    yellowText("Updating package-lock.json ...")
    await updateLock(params, packages, resolvePath(params.destination, './package-lock.json'))
    greenText("package-lock.json updated!")

}

async function updateLock(params, packages, lockpath) {
    if (!fs.existsSync(lockpath) || params.forceLock) await generatelock(params.destination, {})
    let destinationPackageLock = await getPackageLock(params.destination);

    destinationPackageLock = {
        ...destinationPackageLock,
        packages: {
            ...destinationPackageLock.packages,
            "": {
                ...(destinationPackageLock.packages?.[""] ?? {}),
                dependencies: {
                    ...(destinationPackageLock.packages?.[""]?.dependencies ?? {}),
                    ...packages.primary_versions().reduce((prev, cur) => ({ ...prev, ...cur }), {})
                }
            },
            ...packages.content('node_modules/').reduce((prev, cur) => ({ ...prev, ...cur }), {})
        },
        dependencies: {
            ...destinationPackageLock.dependencies,
            ...packages.content().reduce((prev, cur) => ({ ...prev, ...cur }), {})
        }
    }

    fs.writeFileSync(lockpath, JSON.stringify(destinationPackageLock, null, 4))

}
/**
 * @typedef {Object} PackageLockFormat Format of a generic npm package-lock file
 * @property {String} name The name of the package this is a package-lock for.
 * @property {String} version The version of the package this is a package-lock for.
 * @property {String} lockfileVersion 
 * @property {Boolean} requires 
 * @property {Object} packages new way of listing all dependencies
 * @property {Object} dependencies Legacy way of listing all dependencies
 */


/**
 * Entry point to lockgen.js
 * @param {String} path An array of needed packages
 * @param {object} options
 */
async function generatelock(path, { isNPM = true, force = false }) {
    const fullfolderpath = resolvePath(path);
    const fullpath = joinPath(resolvePath(path), `.${isWindows() ? '\\' : '/'}${isNPM ? 'package-lock.json' : 'yarn.lock'}`);
    const fullPackageJsonPath = joinPath(resolvePath(path), `.${isWindows() ? '\\' : '/'}package.json`);

    let cmd = ``
    let cmd2 = `echo "{}" >> ${fullpath}`;
    if (isWindows()) {
        cmd = `if not exist "${fullfolderpath}" mkdir ${fullfolderpath}`
    } else {
        cmd = `mkdir -p ${fullfolderpath}`
    }

    try {
        await execProm(cmd);
        if (fs.existsSync(fullpath) && !force) return;
        if (!fs.existsSync(fullpath)) await execProm(cmd2);

        /**
         * @type {PackageLockFormat}
         */
        let packageLock = JSON.parse(fs.readFileSync(fullpath));
        const packageJson = JSON.parse(fs.readFileSync(fullPackageJsonPath));

        packageLock = {
            name: packageJson.name,
            version: packageJson.version,
            lockfileVersion: 2,
            requires: true,
            packages: {
                "": {
                    name: packageJson.name,
                    version: packageJson.version,
                    lisence: packageJson.lisence,
                    dependencies: {}
                }
            },
            dependencies: {}
        }

        fs.writeFileSync(fullpath, JSON.stringify(packageLock, null, 4));

    } catch (e) {
        console.log(e)
    }
}

module.exports = {
    Params,
    PackageList,
    isWindows,
    redText,
    greenText,
    yellowText,
    resolveSubDependencies,
    getDependencies,
    getPackageLock,
    execProm,
    generatelock,
    updatePackageJson,
    parseParams

}