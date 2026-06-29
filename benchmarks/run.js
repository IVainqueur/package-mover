#!/usr/bin/env node
/**
 * Benchmark suite for package-mover performance characteristics.
 *
 * Measures:
 *  1. PackageList contains/add — Map-backed O(1) vs legacy Array.includes O(n)
 *  2. Dependency resolution — iterative BFS + parallel batches vs sequential recursion
 *  3. Directory copy — Node fs.cp parallel vs single rsync invocation (many small files)
 *  4. End-to-end package transfer on a synthetic fixture tree
 *
 * Usage: node benchmarks/run.js [--json] [--quick]
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const {
    PackageList,
    Params,
    getDependenciesSync,
    resolveSubDependencies,
    resolveAllDependencies,
    copyDirNative,
    copyPackagesParallel,
    mapPool,
    DEFAULT_CONCURRENCY,
} = require('../src/utils');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, '.fixture');
const QUICK = process.argv.includes('--quick');
const AS_JSON = process.argv.includes('--json');

const results = [];

function record(name, metrics) {
    results.push({ name, ...metrics });
    if (!AS_JSON) {
        const parts = Object.entries(metrics)
            .map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`)
            .join('  ');
        console.log(`  ✓ ${name}: ${parts}`);
    }
}

async function timeAsync(fn, iterations = 1) {
    // warmup
    await fn();
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        await fn();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    return {
        ms: sum / times.length,
        minMs: times[0],
        maxMs: times[times.length - 1],
        iterations: times.length,
    };
}

function timeSync(fn, iterations = 1) {
    fn();
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    return {
        ms: sum / times.length,
        minMs: times[0],
        maxMs: times[times.length - 1],
        iterations: times.length,
    };
}

// ─── Legacy implementations (for comparison only) ───────────────────────────

class LegacyPackageList {
    list = [];
    constructor(init) {
        if (init === undefined) return;
        if (!Array.isArray(init)) throw new Error('array required');
        init.forEach(el => this.add(el));
    }
    names() { return this.list.map(el => el.name); }
    values() { return this.list; }
    add(val) {
        if (!Array.isArray(val)) val = [val];
        const names = this.names();
        val.forEach(el => {
            if (names.includes(el.name)) return;
            this.list.push(el);
        });
        return this.list;
    }
    contains(val) { return this.list.map(el => el.name).includes(val); }
    size() { return this.list.length; }
}

async function legacyResolveSequential(packageNames, packages, params, packageLock) {
    for (const pkg of packageNames) {
        packages.add(getDependenciesSync(pkg, params, packageLock, true).values());
    }
    for (const package_name of packages.names()) {
        await resolveSubDependencies(package_name, packages, params, packageLock);
    }
}

async function rsyncCopyAll(sourceRoot, destRoot, packageNames) {
    const srcNm = path.join(sourceRoot, 'node_modules');
    const destNm = path.join(destRoot, 'node_modules');
    await fsp.mkdir(destNm, { recursive: true });
    // Only existing paths (macOS rsync has no --ignore-missing-args)
    const args = packageNames.map(n => path.join(srcNm, n)).filter(p => fs.existsSync(p));
    if (args.length === 0) return;
    // Historical approach: one rsync with many small-file trees (slow on macOS/BSD rsync too)
    const cmd = `rsync -a ${args.map(a => `"${a}"`).join(' ')} "${destNm}/"`;
    await execAsync(cmd, { maxBuffer: 20 * 1024 * 1024 });
}

// ─── Fixture generation ─────────────────────────────────────────────────────

async function ensureFixture() {
    const src = path.join(FIXTURE, 'source');
    const nm = path.join(src, 'node_modules');
    const marker = path.join(FIXTURE, '.ready');
    const pkgCount = QUICK ? 40 : 120;
    const filesPerPkg = QUICK ? 8 : 25;

    if (fs.existsSync(marker)) {
        try {
            const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
            if (meta.pkgCount === pkgCount && meta.filesPerPkg === filesPerPkg) return { src, pkgCount };
        } catch { /* rebuild */ }
        await fsp.rm(FIXTURE, { recursive: true, force: true });
    }

    if (!AS_JSON) console.log(`\nGenerating fixture (${pkgCount} packages × ${filesPerPkg} small files)...`);

    await fsp.mkdir(nm, { recursive: true });

    const lockPackages = {
        '': { name: 'bench-source', version: '1.0.0', dependencies: {} },
    };
    const lockDeps = {};
    const rootDeps = {};

    for (let i = 0; i < pkgCount; i++) {
        const name = `bench-pkg-${i}`;
        const dir = path.join(nm, name);
        await fsp.mkdir(dir, { recursive: true });

        // Many small files (rsync worst case)
        for (let f = 0; f < filesPerPkg; f++) {
            await fsp.writeFile(path.join(dir, `file-${f}.txt`), `content-${i}-${f}\n`);
        }
        // A few empty files
        for (let f = 0; f < 3; f++) {
            await fsp.writeFile(path.join(dir, `empty-${f}.dat`), '');
        }

        const deps = {};
        // Fan-out tree: each package depends on next 3 so one primary pulls nearly all packages
        for (let d = 1; d <= 3; d++) {
            if (i + d < pkgCount) deps[`bench-pkg-${i + d}`] = '1.0.0';
        }
        // Also link backwards a bit for denser graph / more contains() checks
        if (i > 0 && i % 4 === 0) deps[`bench-pkg-${i - 1}`] = '1.0.0';

        const pkgJson = { name, version: '1.0.0', dependencies: deps };
        // Lockfile lockfileVersion 2 stores deps under "dependencies" on the package entry
        await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        lockPackages[`node_modules/${name}`] = {
            version: '1.0.0',
            dependencies: deps,
        };
        lockDeps[name] = { version: '1.0.0', requires: deps };
        if (i < 8) rootDeps[name] = '^1.0.0';
    }

    lockPackages[''].dependencies = rootDeps;

    await fsp.writeFile(path.join(src, 'package.json'), JSON.stringify({
        name: 'bench-source',
        version: '1.0.0',
        dependencies: rootDeps,
    }, null, 2));

    await fsp.writeFile(path.join(src, 'package-lock.json'), JSON.stringify({
        name: 'bench-source',
        version: '1.0.0',
        lockfileVersion: 2,
        requires: true,
        packages: lockPackages,
        dependencies: lockDeps,
    }, null, 2));

    await fsp.writeFile(marker, JSON.stringify({ pkgCount, filesPerPkg }));
    return { src, pkgCount };
}

async function makeDest() {
    const dest = path.join(FIXTURE, `dest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, 'package.json'), JSON.stringify({
        name: 'bench-dest',
        version: '1.0.0',
        dependencies: {},
    }, null, 2));
    return dest;
}

// ─── Benchmarks ─────────────────────────────────────────────────────────────

async function benchPackageList() {
    if (!AS_JSON) console.log('\n[1/4] PackageList membership (Map vs Array.includes)');
    const N = QUICK ? 2000 : 8000;
    const items = Array.from({ length: N }, (_, i) => ({ name: `pkg-${i}`, content: { version: '1.0.0' } }));

    const legacy = timeSync(() => {
        const list = new LegacyPackageList();
        for (const it of items) list.add(it);
        for (let i = 0; i < N; i++) list.contains(`pkg-${i % N}`);
        for (let i = 0; i < 500; i++) list.contains(`missing-${i}`);
    }, QUICK ? 2 : 4);

    const optimized = timeSync(() => {
        const list = new PackageList();
        for (const it of items) list.add(it);
        for (let i = 0; i < N; i++) list.contains(`pkg-${i % N}`);
        for (let i = 0; i < 500; i++) list.contains(`missing-${i}`);
    }, QUICK ? 2 : 4);

    const speedup = legacy.ms / optimized.ms;
    record('PackageList Map vs Array', {
        legacyMs: legacy.ms,
        optimizedMs: optimized.ms,
        speedup: `${speedup.toFixed(2)}x`,
        n: N,
    });

    if (optimized.ms > legacy.ms * 1.1) {
        throw new Error(`PackageList regression: optimized (${optimized.ms}ms) slower than legacy (${legacy.ms}ms)`);
    }
}

async function benchDependencyResolution(src, pkgCount) {
    if (!AS_JSON) console.log('\n[2/4] Dependency resolution (sequential recursion vs parallel BFS)');
    const lock = JSON.parse(fs.readFileSync(path.join(src, 'package-lock.json'), 'utf8'));
    const params = new Params(['bench-pkg-0'], src, src, false);
    // Multiple primaries so parallel mapPool has real work; tree fans out to most packages
    const primaries = Array.from({ length: Math.min(8, pkgCount) }, (_, i) => `bench-pkg-${i}`);
    const iterations = QUICK ? 8 : 20;

    const legacy = await timeAsync(async () => {
        const packages = new PackageList();
        await legacyResolveSequential(primaries, packages, params, lock);
        return packages.size();
    }, iterations);

    const optimized = await timeAsync(async () => {
        const packages = new PackageList();
        await resolveAllDependencies(primaries, packages, params, lock, DEFAULT_CONCURRENCY);
        return packages.size();
    }, iterations);

    // Correctness: both should discover the same set size
    const a = new PackageList();
    await legacyResolveSequential(primaries, a, params, lock);
    const b = new PackageList();
    await resolveAllDependencies(primaries, b, params, lock, DEFAULT_CONCURRENCY);
    if (a.size() !== b.size()) {
        throw new Error(`Resolution mismatch: legacy=${a.size()} optimized=${b.size()}`);
    }
    // Must resolve a non-trivial transitive set (fixture fan-out)
    if (b.size() < Math.min(pkgCount, 10)) {
        throw new Error(`Resolution too shallow: only ${b.size()} packages (expected wider tree)`);
    }

    const speedup = legacy.ms / Math.max(optimized.ms, 0.001);
    record('Dependency resolution', {
        legacyMs: legacy.ms,
        optimizedMs: optimized.ms,
        speedup: `${speedup.toFixed(2)}x`,
        packagesResolved: b.size(),
        primaries: primaries.length,
    });
}

async function benchCopy(src, pkgCount) {
    if (!AS_JSON) console.log('\n[3/4] Directory copy (rsync vs Node fs.cp parallel)');
    if (process.platform === 'win32') {
        record('Directory copy', { skipped: true, reason: 'rsync not applicable on Windows' });
        return;
    }

    // Use a subset of packages for fair comparison timing
    const subset = Array.from({ length: Math.min(pkgCount, QUICK ? 30 : 80) }, (_, i) => `bench-pkg-${i}`);

    let rsyncMs = null;
    try {
        const destR = await makeDest();
        const r = await timeAsync(async () => {
            // clean dest node_modules between iters
            const nm = path.join(destR, 'node_modules');
            await fsp.rm(nm, { recursive: true, force: true });
            await rsyncCopyAll(src, destR, subset);
        }, 1);
        rsyncMs = r.ms;
        await fsp.rm(destR, { recursive: true, force: true });
    } catch (e) {
        if (!AS_JSON) console.log('  (rsync unavailable, skipping rsync baseline:', e.message, ')');
    }

    const destN = await makeDest();
    const native = await timeAsync(async () => {
        const nm = path.join(destN, 'node_modules');
        await fsp.rm(nm, { recursive: true, force: true });
        await copyPackagesParallel(src, destN, subset, DEFAULT_CONCURRENCY);
    }, QUICK ? 1 : 2);
    await fsp.rm(destN, { recursive: true, force: true });

    // Verify files landed
    const destCheck = await makeDest();
    await copyPackagesParallel(src, destCheck, subset.slice(0, 5), DEFAULT_CONCURRENCY);
    const sample = path.join(destCheck, 'node_modules', 'bench-pkg-0', 'package.json');
    if (!fs.existsSync(sample)) {
        throw new Error('Native copy failed: sample package missing');
    }
    await fsp.rm(destCheck, { recursive: true, force: true });

    const metrics = {
        optimizedMs: native.ms,
        packages: subset.length,
        concurrency: DEFAULT_CONCURRENCY,
    };
    if (rsyncMs != null) {
        metrics.rsyncMs = rsyncMs;
        metrics.speedup = `${(rsyncMs / Math.max(native.ms, 0.001)).toFixed(2)}x`;
    }
    record('Directory copy (many small files)', metrics);
}

async function benchEndToEnd(src) {
    if (!AS_JSON) console.log('\n[4/4] End-to-end package-mover transfer');
    const dest = await makeDest();
    const { start } = require('../src/commands/mover');

    const t = await timeAsync(async () => {
        // Reset dest package.json / remove node_modules between runs
        await fsp.rm(path.join(dest, 'node_modules'), { recursive: true, force: true });
        await fsp.writeFile(path.join(dest, 'package.json'), JSON.stringify({
            name: 'bench-dest',
            version: '1.0.0',
            dependencies: {},
        }, null, 2));
        const lockPath = path.join(dest, 'package-lock.json');
        if (fs.existsSync(lockPath)) await fsp.unlink(lockPath);

        await start({
            source: src,
            destination: dest,
            packages: ['bench-pkg-0', 'bench-pkg-1'],
            logErrors: false,
            alreadyParsed: true,
        });
    }, 1);

    // Sanity checks
    const destPkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    if (!destPkg.dependencies['bench-pkg-0']) {
        throw new Error('E2E: destination package.json missing bench-pkg-0');
    }
    if (!fs.existsSync(path.join(dest, 'node_modules', 'bench-pkg-0'))) {
        throw new Error('E2E: node_modules/bench-pkg-0 not copied');
    }

    record('End-to-end transfer', {
        ms: t.ms,
        primaryPackages: 2,
        dest: path.basename(dest),
    });

    // Keep last dest for inspection only in non-CI; always clean to save disk
    await fsp.rm(dest, { recursive: true, force: true });
}

async function main() {
    if (!AS_JSON) {
        console.log('package-mover benchmarks');
        console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`);
        console.log(`cpus=${os.cpus().length} concurrency=${DEFAULT_CONCURRENCY} quick=${QUICK}`);
    }

    const { src, pkgCount } = await ensureFixture();

    await benchPackageList();
    await benchDependencyResolution(src, pkgCount);
    await benchCopy(src, pkgCount);
    await benchEndToEnd(src);

    if (AS_JSON) {
        console.log(JSON.stringify({ results, meta: { platform: process.platform, node: process.version, concurrency: DEFAULT_CONCURRENCY } }, null, 2));
    } else {
        console.log('\nAll benchmarks passed.');
        const outPath = path.join(__dirname, 'last-results.json');
        fs.writeFileSync(outPath, JSON.stringify({ results, at: new Date().toISOString() }, null, 2));
        console.log(`Results written to ${path.relative(ROOT, outPath)}`);
    }
}

main().catch((err) => {
    console.error('\nBenchmark failed:', err.message || err);
    process.exit(1);
});
