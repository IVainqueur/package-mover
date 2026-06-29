const { resolve: resolvePath, join: joinPath, dirname } = require('path')
const fs = require('fs');
const fsp = require('fs').promises;
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const { performance } = require('perf_hooks');

const execFileAsync = promisify(execFile);

/** Default concurrency for bounded parallel work */
const DEFAULT_CONCURRENCY = Math.max(4, Math.min(32, (require('os').cpus()?.length || 4) * 2));

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

/**
 * PackageList backed by Map for O(1) contains/add lookups (was O(n) array + includes).
 */
class PackageList {
    /** @type {Map<string, object>} */
    #byName = new Map();

    constructor(init) {
        if (init === undefined) return;
        if (!Array.isArray(init)) throw new Error("PackageList constructor receives array of initial values")
        for (const el of init) this.add(el);
    }
    /**
     * @returns {String[]} an array of all the packages' names
     */
    names() {
        return Array.from(this.#byName.keys());
    }
    /**
     * @returns {object[]} an array of all package objects stored
     */
    values() {
        return Array.from(this.#byName.values());
    }
    /**
     * @param {String} prefix
     * @returns {object} an object of all packages with the names concatenated with the prefix
     */
    content(prefix = '') {
        const out = {};
        for (const el of this.#byName.values()) {
            out[prefix + el.name] = el.content ?? {};
        }
        return out;
    }
    /**
     * @returns {object} an object of all package names as keys and their versions as values
     */
    versions() {
        const out = {};
        for (const el of this.#byName.values()) {
            out[el.name] = el.content?.version ?? "1.0.0";
        }
        return out;
    }
    /**
     * `primary packages` are the main packages that are specified once the program is run
     * @returns {object[]} an array of the primary packages
     */
    primary() {
        return this.values().filter(({ isPrimary }) => isPrimary)
    }
    /**
     * Works like .versions() but only the versions of the `primary packages`
     * @returns {object} primary packages' names as keys and versions as values
     */
    primary_versions() {
        const out = {};
        for (const el of this.#byName.values()) {
            if (el.isPrimary) out[el.name] = '^' + (el.content?.version ?? "1.0.0");
        }
        return out;
    }
    /**
     * @param {object | object[]} val an object or array of objects to add to the list
     * @returns {object[]} the updated list values
     */
    add(val) {
        if (!Array.isArray(val)) val = [val]
        for (const el of val) {
            if (!el?.name || this.#byName.has(el.name)) continue;
            this.#byName.set(el.name, el);
        }
        return this.values();
    }
    /**
     * @param {String} val Name of a package that might be in the list
     * @returns {boolean}
     */
    contains(val) {
        return this.#byName.has(val);
    }
    /**
     * @returns {number} the current length of the list
     */
    size() {
        return this.#byName.size;
    }
}

/**
 * Run async tasks over items with a fixed concurrency limit (avoids unbounded Promise.all).
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;
    const limit = Math.max(1, concurrency | 0);

    async function run() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i], i);
        }
    }

    const runners = Array.from({ length: Math.min(limit, items.length || 1) }, () => run());
    await Promise.all(runners);
    return results;
}

/**
 * Parses the parameters if they're not already parsed and returns a `Params` object
 * @param {object} args arguments provided running the program ( from `process` )
 * @returns {Params}
 */
function parseParams(args) {
    if (args.alreadyParsed) return new Params(args.packages, args.source, args.destination, args.logErrors)
    const p = new Params();
    for (let arg of args) {
        const [key, value] = arg.split("=");
        if (Params.args.get(key)) p[Params.args.get(key)] = value;
    }
    for (const param of ["source", "destination", "packages"]) {
        if (!!p[param]) continue;
        redText(`[error] missing --${param} parameter`)
        process.exit(1);
    }
    p.packages = p.packages.split(',')
    return p;
}

/**
 * @returns {boolean} `true` if the OS is Windows, `false` otherwise.
 */
function isWindows() {
    return process.platform === 'win32'
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

/**
 * Finds the direct sub-dependencies of `package` from `packageLock` if it is specified.
 * Synchronous core kept for speed; async wrapper preserves API compatibility.
 * @param {String} package The package for which to resolve dependencies
 * @param {Object} params The parameters provided at the beginning of the program
 * @param {Object} packageLock the lock file of the source directory
 * @param {boolean} isPrimary is `package` a primary package?
 * @returns {Promise<PackageList>}
 */
async function getDependencies(package, params, packageLock, isPrimary) {
    return getDependenciesSync(package, params, packageLock, isPrimary);
}

/**
 * Synchronous dependency lookup (no await needed — lock is already in memory).
 * @returns {PackageList}
 */
function getDependenciesSync(package, params, packageLock, isPrimary) {
    let packages = new PackageList();
    const package_key = params.legacy ? package : `node_modules/${package}`
    // Lockfile v2 package entries expose transitive deps under `dependencies` (not `packages`).
    // Primary packages also scan peer/optional/dev from the lock entry when present.
    const depTypes = isPrimary
        ? Params.dependencyTypes
        : ['dependencies', 'optionalDependencies', 'peerDependencies']

    try {
        const lockRoot = packageLock
            ? (packageLock[params.legacy ? 'dependencies' : 'packages'] ?? {})
            : null;

        let packageInfo = !packageLock
            ?
            JSON.parse(fs.readFileSync(`${params.source}${isWindows() ? '\\' : '/'}node_modules/${package}/package.json`))
            :
            (lockRoot[package_key] ?? {});

        if (Object.keys(packageInfo).length == 0) return packages

        packages.add([
            {
                name: package,
                isPrimary,
                content: lockRoot ? (lockRoot[package_key] ?? {}) : packageInfo
            }
        ])

        for (let dependencyType of depTypes) {
            const section = packageInfo[dependencyType];
            if (!section || typeof section !== 'object') continue;
            const entries = Object.keys(section).map(el => {
                const _el = params.legacy ? el : `node_modules/${el}`
                return ({
                    name: el,
                    content: lockRoot ? (lockRoot[_el] ?? {}) : {}
                })
            });
            packages.add(entries);
        }
    } catch (e) {
        if (params.logErrors) redText("[Error] Failed to resolve :", package);
        if (params.logErrors) console.log(e)
    }
    if (params.logErrors) console.log(`[${package}] depends on`, packages.size(), 'packages')
    return packages;
}

/**
 * Iterative BFS dependency resolution with O(1) membership checks.
 * Avoids deep recursion and sequential await chains (O(n) latency stacking).
 *
 * @param {String} package The package for which to resolve dependencies
 * @param {PackageList} mainPackages The PackageList containing all the packages so far
 * @param {Object} params The parameters provided at the beginning of the program
 * @param {Object} package_lock the lock file of the source directory
 */
async function resolveSubDependencies(package, mainPackages, params, package_lock) {
    const queue = [package];
    const queued = new Set([package]);

    while (queue.length > 0) {
        const current = queue.shift();
        const subpackages = getDependenciesSync(current, params, package_lock, false);
        for (const subpackage of subpackages.values()) {
            if (!mainPackages.contains(subpackage.name) && !queued.has(subpackage.name)) {
                queued.add(subpackage.name);
                queue.push(subpackage.name);
            }
            mainPackages.add(subpackage);
        }
    }
}

/**
 * Resolve many primary packages in parallel (bounded), then BFS-fill transitive deps.
 * @param {string[]} packageNames
 * @param {PackageList} packages
 * @param {object} params
 * @param {object} packageLock
 * @param {number} [concurrency]
 */
async function resolveAllDependencies(packageNames, packages, params, packageLock, concurrency = DEFAULT_CONCURRENCY) {
    // Primary packages in parallel
    await mapPool(packageNames, concurrency, async (pkg) => {
        packages.add((await getDependencies(pkg, params, packageLock, true)).values());
    });

    // Transitive deps — iterative BFS over current names (may grow)
    const pending = packages.names().filter(n => !packageNames.includes(n) || true);
    // Seed queue with all names already in list for full transitive walk
    const seen = new Set();
    const queue = packages.names().slice();

    while (queue.length > 0) {
        // Process a batch in parallel for CPU/cache locality on lock lookups
        const batch = [];
        while (queue.length > 0 && batch.length < concurrency) {
            const name = queue.shift();
            if (seen.has(name)) continue;
            seen.add(name);
            batch.push(name);
        }
        if (batch.length === 0) continue;

        await mapPool(batch, concurrency, async (name) => {
            const sub = getDependenciesSync(name, params, packageLock, false);
            for (const subpackage of sub.values()) {
                if (!packages.contains(subpackage.name)) {
                    packages.add(subpackage);
                    if (!seen.has(subpackage.name)) queue.push(subpackage.name);
                } else {
                    packages.add(subpackage);
                }
            }
        });
    }
}

/**
 * @param {String} src relative or absolute path to the source destination
 * @param {Params} params program parameters
 * @returns {object|Promise<object>} object containing the lock file in `src`
 */
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
 * Promisified child_process.exec (legacy path; prefer execFileProm for args safety/perf)
 * @param {String} command The command to run
 */
function execProm(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(err)
            // Don't reject on stderr alone — many tools write warnings there
            resolve(stdout)
        })
    })
}

/**
 * Prefer execFile over shell when possible (no shell spawn overhead / injection).
 * @param {string} file
 * @param {string[]} args
 */
function execFileProm(file, args = []) {
    return execFileAsync(file, args, { maxBuffer: 20 * 1024 * 1024 });
}

/**
 * Recursively copy a directory using Node fs.cp (Node 16.7+).
 * Beats rsync for huge trees of tiny files (no process + protocol overhead per transfer).
 * Falls back to cp -R / xcopy when fs.cp is unavailable.
 * @param {string} src
 * @param {string} dest
 */
async function copyDirNative(src, dest) {
    if (typeof fsp.cp === 'function') {
        await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
        return;
    }
    // Fallback for older Node
    if (isWindows()) {
        await execProm(`xcopy /E /C /Q /G /H /Y "${src}" "${dest}\\"`);
    } else {
        await fsp.mkdir(dest, { recursive: true });
        await execFileProm('cp', ['-a', `${src}/.`, dest]);
    }
}

/**
 * Copy many package folders from source node_modules into destination node_modules
 * in parallel with a concurrency limit — avoids one giant rsync argv and sequential copies.
 * @param {string} sourceRoot
 * @param {string} destRoot
 * @param {string[]} packageNames unique package folder names (supports scoped @scope/name)
 * @param {number} [concurrency]
 */
async function copyPackagesParallel(sourceRoot, destRoot, packageNames, concurrency = DEFAULT_CONCURRENCY) {
    const srcNm = joinPath(resolvePath(sourceRoot), 'node_modules');
    const destNm = joinPath(resolvePath(destRoot), 'node_modules');
    await fsp.mkdir(destNm, { recursive: true });

    // Deduplicate while preserving order
    const unique = [...new Set(packageNames.filter(Boolean))];

    const results = await mapPool(unique, concurrency, async (name) => {
        const from = joinPath(srcNm, name);
        const to = joinPath(destNm, name);
        try {
            await fsp.access(from);
        } catch {
            return { name, ok: false, reason: 'missing' };
        }
        // Ensure parent exists for scoped packages (@scope/pkg)
        await fsp.mkdir(dirname(to), { recursive: true });
        const t0 = performance.now();
        await copyDirNative(from, to);
        return { name, ok: true, ms: performance.now() - t0 };
    });

    return results;
}

/**
 * Updates the `params.destination`'s package.json and lock file
 * @param {Params} params the program parameters
 * @param {PackageList} packages PackageList of all the packages to add to the destination project
 */
async function updatePackageJson(params, packages) {
    const source = JSON.parse(fs.readFileSync(`${params.source}/package.json`));
    const destination = JSON.parse(fs.readFileSync(`${params.destination}/package.json`));

    const updatedDeps = Object.create(null);
    for (const dependencyType of Params.dependencyTypes) {
        updatedDeps[dependencyType] = Object.create(null);
    }

    // Single pass over primary packages × dep types (was nested object-spread O(n²) copies)
    for (const packageName of params.packages) {
        for (const dependencyType of Params.dependencyTypes) {
            const ver = source[dependencyType]?.[packageName];
            if (ver != null) updatedDeps[dependencyType][packageName] = ver;
        }
    }

    // Hoist peerDependencies of transferred packages to destination dependencies (issue alternative)
    for (const pkg of packages.values()) {
        const peers = pkg.content?.peerDependencies;
        if (!peers) continue;
        for (const [peerName, peerRange] of Object.entries(peers)) {
            if (destination.dependencies?.[peerName] || destination.peerDependencies?.[peerName]) continue;
            if (packages.contains(peerName)) {
                // Peer is being copied — ensure it appears in destination dependencies when primary
                continue;
            }
            // Record peer at top level so callers can satisfy it (documented alternative from #1)
            destination.peerDependencies = destination.peerDependencies || {};
            if (!destination.peerDependencies[peerName]) {
                destination.peerDependencies[peerName] = peerRange;
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

    yellowText("Updating package-lock.json ...")
    await updateLock(params, packages, resolvePath(params.destination, './package-lock.json'))
    greenText("package-lock.json updated!")
}

/**
 * Updates the `params.destination` lock file.
 * @param {Params} params
 * @param {PackageList} packages
 * @param {String} lockpath
 */
async function updateLock(params, packages, lockpath) {
    if (!fs.existsSync(lockpath) || params.forceLock) await generatelock(params.destination, {})
    let destinationPackageLock = await getPackageLock(params.destination);

    const packagesSection = packages.content('node_modules/');
    const depsSection = packages.content();
    const primaryVersions = packages.primary_versions();

    destinationPackageLock = {
        ...destinationPackageLock,
        packages: {
            ...destinationPackageLock.packages,
            "": {
                ...(destinationPackageLock.packages?.[""] ?? {}),
                dependencies: {
                    ...(destinationPackageLock.packages?.[""]?.dependencies ?? {}),
                    ...primaryVersions
                }
            },
            ...packagesSection
        },
        dependencies: {
            ...destinationPackageLock.dependencies,
            ...depsSection
        }
    }

    fs.writeFileSync(lockpath, JSON.stringify(destinationPackageLock, null, 4))
}

/**
 * @typedef {Object} PackageLockFormat Format of a generic npm package-lock file
 * @property {String} name
 * @property {String} version
 * @property {String} lockfileVersion
 * @property {Boolean} requires
 * @property {Object} packages
 * @property {Object} dependencies
 */

/**
 * @param {String} path
 * @param {object} options
 */
async function generatelock(path, { isNPM = true, force = false }) {
    const fullfolderpath = resolvePath(path);
    const fullpath = joinPath(resolvePath(path), `.${isWindows() ? '\\' : '/'}${isNPM ? 'package-lock.json' : 'yarn.lock'}`);
    const fullPackageJsonPath = joinPath(resolvePath(path), `.${isWindows() ? '\\' : '/'}package.json`);

    try {
        await fsp.mkdir(fullfolderpath, { recursive: true });
        if (fs.existsSync(fullpath) && !force) return;
        if (!fs.existsSync(fullpath)) {
            fs.writeFileSync(fullpath, '{}');
        }

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
                    license: packageJson.license ?? packageJson.lisence,
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
    resolveAllDependencies,
    getDependencies,
    getDependenciesSync,
    getPackageLock,
    execProm,
    execFileProm,
    generatelock,
    updatePackageJson,
    parseParams,
    mapPool,
    copyDirNative,
    copyPackagesParallel,
    DEFAULT_CONCURRENCY,
}
