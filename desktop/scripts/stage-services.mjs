#!/usr/bin/env node
/**
 * Stage the NestJS services into a self-contained tree the Electron app can ship.
 *
 * The repo is an npm workspace: every dependency is hoisted to the root
 * node_modules, and the workspace packages themselves are symlinks. Neither
 * survives packaging — electron-builder would either follow the symlinks out of
 * the app directory or copy the whole hoisted tree, most of which is frontend
 * devDependencies. So instead of pointing a packager at the repo, we build a
 * fresh dependency tree per service from a generated package.json.
 *
 * Two rewrites make that tree installable outside the workspace:
 *
 *   "@luminary-media-converter/hls": "*"  ->  "file:<abs path>"
 *       "*" only resolves because the workspace links it. Outside, npm asks the
 *       public registry and gets a 404.
 *
 *   "node-tusd": "file:../tusd"          ->  dropped (api only)
 *       The desktop build reads sources off local disk and runs with
 *       TUS_ENABLED=false, so tusd never starts. Dropping it keeps a 65 MB
 *       platform-specific Go binary out of every installer. This is only safe
 *       because the import is dynamic — see TusUploadService.onModuleInit.
 *
 * Usage: node scripts/stage-services.mjs [api|saas ...]   (default: api)
 *
 * Only the encoder ships. The desktop build has no authentication and therefore
 * no multi-tenancy, which leaves the SaaS session document a second copy of
 * state the encoder already persists to WORK_DIR — so the encoder is the source
 * of truth and saas/ is not part of the app. It stays stageable here because
 * the config costs nothing and the hosted product still uses it.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '..');
const STAGE_ROOT = join(DESKTOP_DIR, 'build', 'resources', 'services');

/** Workspace packages that must be rewritten from "*" to a file: path. */
const WORKSPACE_SCOPE = '@luminary-media-converter/';

const SERVICES = {
    api: {
        /** Dependencies to omit from the staged tree entirely. */
        drop: ['node-tusd'],
        /**
         * Files that must survive as real files on disk. Worker threads are
         * resolved with join(__dirname, ...) at runtime, so a bundler or asar
         * would break them — this asserts they are present and unpacked.
         */
        requireFiles: [
            'dist/main.js',
            'dist/encode/services/encryption.worker.js',
            'dist/encode/services/byte-range.worker.js',
        ],
        /** Started for real during verification. */
        boot: {
            PORT: '31997',
            BIND_HOST: '127.0.0.1',
            TUS_ENABLED: 'false',
            MASTER_API_KEY: 'stage-check',
        },
    },
    saas: {
        drop: [],
        requireFiles: ['dist/main.js'],
        // Not booted: JwtStrategy and CryptoService both throw in their
        // constructors without Auth0 and S3_ENCRYPTION_KEY, and local mode for
        // those lands in a later phase. The module graph still has to resolve,
        // which is what catches a missing dependency.
        boot: null,
    },
};

function log(msg) {
    console.log(`  ${msg}`);
}

function run(cmd, args, opts = {}) {
    const { quiet, ...rest } = opts;
    return execFileSync(cmd, args, {
        stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf-8',
        ...rest,
    });
}

/**
 * Build the package.json the staged service installs from: dependencies only,
 * with workspace references made resolvable and dropped entries removed.
 *
 * Note what is deliberately absent: "type". Both services compile to CommonJS,
 * and adding "type": "module" here would break every require() in dist/.
 */
function stagedManifest(name, config) {
    const source = JSON.parse(
        readFileSync(join(REPO_ROOT, name, 'package.json'), 'utf-8')
    );

    const dependencies = {};
    for (const [dep, range] of Object.entries(source.dependencies ?? {})) {
        if (config.drop.includes(dep)) {
            log(`dropped ${dep}`);
            continue;
        }

        if (dep.startsWith(WORKSPACE_SCOPE)) {
            const dir = join(REPO_ROOT, dep.slice(WORKSPACE_SCOPE.length));
            if (!existsSync(dir)) {
                throw new Error(
                    `${name} depends on ${dep}, but ${dir} does not exist`
                );
            }
            dependencies[dep] = `file:${dir}`;
            log(
                `rewrote ${dep}: "${range}" -> file:${relative(REPO_ROOT, dir)}`
            );
            continue;
        }

        if (range.startsWith('file:')) {
            // Any other relative workspace link, made absolute so it resolves
            // from the staged directory rather than the original one.
            const dir = resolve(REPO_ROOT, name, range.slice('file:'.length));
            dependencies[dep] = `file:${dir}`;
            log(`rewrote ${dep}: "${range}" -> absolute file:`);
            continue;
        }

        dependencies[dep] = range;
    }

    return {
        name: `${source.name}-staged`,
        version: source.version ?? '0.0.0',
        private: true,
        main: 'dist/main.js',
        dependencies,
    };
}

/**
 * Remove every node_modules/.bin directory.
 *
 * npm fills these with symlinked CLI shims for any dependency declaring a
 * "bin". Nothing require()s them, the services never shell out to them, and
 * they are the only symlinks npm leaves behind once --install-links has copied
 * the file: dependencies — so dropping them lets the symlink assertion below
 * stay absolute instead of carrying an exception list.
 */
function pruneBinShims(root, removed = { count: 0 }) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory()) continue;

        const path = join(root, entry.name);
        if (entry.name === '.bin') {
            rmSync(path, { recursive: true, force: true });
            removed.count++;
            continue;
        }
        pruneBinShims(path, removed);
    }
    return removed.count;
}

/** Every path in the tree that is a symlink. Must be empty for packaging. */
function findSymlinks(root, found = []) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink()) {
            found.push(path);
        } else if (entry.isDirectory()) {
            findSymlinks(path, found);
        }
    }
    return found;
}

function stage(name) {
    const config = SERVICES[name];
    if (!config) throw new Error(`Unknown service: ${name}`);

    console.log(`\n[${name}] staging`);

    const stageDir = join(STAGE_ROOT, name);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    // hls is consumed by both services and is a plain tsc build, so it has to
    // exist before npm packs it as a file: dependency.
    run('npm', ['-w', 'hls', 'run', 'build'], { cwd: REPO_ROOT, quiet: true });
    run('npm', ['-w', name, 'run', 'build'], { cwd: REPO_ROOT, quiet: true });

    const distDir = join(REPO_ROOT, name, 'dist');
    if (!existsSync(distDir)) {
        throw new Error(`${name} build produced no dist/ at ${distDir}`);
    }
    cpSync(distDir, join(stageDir, 'dist'), { recursive: true });

    writeFileSync(
        join(stageDir, 'package.json'),
        JSON.stringify(stagedManifest(name, config), null, 2) + '\n'
    );

    log('installing production dependencies');
    run(
        'npm',
        [
            'install',
            '--omit=dev',
            // Copy file: dependencies instead of symlinking them. Without this
            // the staged tree contains links back into the repo.
            '--install-links',
            '--no-audit',
            '--no-fund',
            '--no-package-lock',
        ],
        { cwd: stageDir, quiet: true }
    );

    const pruned = pruneBinShims(join(stageDir, 'node_modules'));
    if (pruned > 0) log(`pruned ${pruned} .bin shim director(ies)`);

    freezeManifest(stageDir);

    return stageDir;
}

/**
 * Replace the absolute file: specifiers with the versions that were actually
 * installed.
 *
 * They exist only so npm can find the workspace packages during staging, and
 * they embed the build machine's home directory. Nothing reads dependency
 * ranges at runtime, but this manifest ships inside every installer, so it
 * should describe the tree rather than the machine that produced it.
 */
function freezeManifest(stageDir) {
    const manifestPath = join(stageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    for (const [dep, range] of Object.entries(manifest.dependencies)) {
        if (!range.startsWith('file:')) continue;
        const installed = join(stageDir, 'node_modules', dep, 'package.json');
        if (!existsSync(installed)) {
            throw new Error(`${dep} was declared but not installed`);
        }
        manifest.dependencies[dep] = JSON.parse(
            readFileSync(installed, 'utf-8')
        ).version;
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Prove the staged tree stands on its own.
 *
 * The checks run against a copy in the system temp directory, outside the repo.
 * Run in place, Node would walk up and resolve anything missing from the repo's
 * hoisted root node_modules — so a tree with a missing dependency would pass.
 */
async function verify(name, stageDir) {
    const config = SERVICES[name];
    console.log(`\n[${name}] verifying`);

    for (const file of config.requireFiles) {
        if (!existsSync(join(stageDir, file))) {
            throw new Error(`${name}: missing required file ${file}`);
        }
    }
    log(`${config.requireFiles.length} required file(s) present`);

    const symlinks = findSymlinks(stageDir);
    if (symlinks.length > 0) {
        throw new Error(
            `${name}: ${symlinks.length} symlink(s) in the staged tree, ` +
                `which will not survive packaging:\n  ` +
                symlinks
                    .slice(0, 5)
                    .map((p) => relative(stageDir, p))
                    .join('\n  ')
        );
    }
    log('no symlinks');

    for (const dep of config.drop) {
        if (existsSync(join(stageDir, 'node_modules', dep))) {
            throw new Error(`${name}: ${dep} was dropped but still installed`);
        }
    }
    if (config.drop.length > 0) {
        log(`dropped dependencies absent: ${config.drop.join(', ')}`);
    }

    const sandbox = mkdtempSync(join(tmpdir(), `lmc-stage-${name}-`));
    try {
        const isolated = join(sandbox, name);
        cpSync(stageDir, isolated, { recursive: true });

        // Loading the root module resolves the entire dependency graph without
        // starting anything, which is what catches an omitted package.
        run('node', ['-e', "require('./dist/app.module.js')"], {
            cwd: isolated,
            quiet: true,
        });
        log('module graph resolves outside the repo');

        if (config.boot) await bootCheck(name, isolated, config.boot);
    } finally {
        rmSync(sandbox, { recursive: true, force: true });
    }
}

/** Start the service for real and confirm it serves a request, then stop it. */
async function bootCheck(name, dir, env) {
    const workDir = join(dir, '.boot-work');
    mkdirSync(workDir, { recursive: true });

    const proc = spawn(process.execPath, ['dist/main.js'], {
        cwd: dir,
        env: { ...process.env, ...env, WORK_DIR: workDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));

    let exited = null;
    proc.on('exit', (code) => (exited = code));

    // Any HTTP answer proves it is listening; 401 is the expected one here,
    // since the probe deliberately carries no credentials.
    const url = `http://${env.BIND_HOST}:${env.PORT}/api/sessions/probe`;
    const deadline = Date.now() + 30_000;

    try {
        while (Date.now() < deadline) {
            if (exited !== null) {
                throw new Error(
                    `${name}: exited during boot (code ${exited})\n${output}`
                );
            }
            try {
                const res = await fetch(url);
                log(`booted and answered on port ${env.PORT} (HTTP ${res.status})`);
                return;
            } catch {
                await delay(500);
            }
        }
        throw new Error(`${name}: did not answer within 30s\n${output}`);
    } finally {
        proc.kill('SIGTERM');
        // Give the shutdown hooks a moment so the sandbox can be removed.
        await delay(500);
        if (exited === null) proc.kill('SIGKILL');
    }
}

function directorySize(dir) {
    let bytes = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        bytes += entry.isDirectory()
            ? directorySize(path)
            : entry.isFile()
              ? readFileSync(path).byteLength
              : 0;
    }
    return bytes;
}

/**
 * Build the Vue app for desktop and copy it next to the services.
 *
 * `--mode desktop` swaps Auth0 and the service worker for local stubs and emits
 * to its own directory, so the web build is never overwritten.
 */
function stageRenderer() {
    console.log('\n[renderer] staging');

    run('npm', ['-w', 'app', 'run', 'build:desktop'], {
        cwd: REPO_ROOT,
        quiet: true,
    });

    const built = join(REPO_ROOT, 'app', 'dist-desktop');
    if (!existsSync(join(built, 'index.html'))) {
        throw new Error(`renderer build produced no index.html at ${built}`);
    }

    const stageDir = join(DESKTOP_DIR, 'build', 'resources', 'renderer');
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    cpSync(built, stageDir, { recursive: true });

    // A service worker would fight the shell's SPA fallback, and the manifest
    // describes an installable web app. Neither belongs in a packaged build.
    for (const stray of ['sw.js', 'registerSW.js', 'manifest.webmanifest']) {
        rmSync(join(stageDir, stray), { force: true });
    }

    log('built and copied');
    return stageDir;
}

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ['api', 'renderer'];

for (const name of targets) {
    if (name === 'renderer') {
        const dir = stageRenderer();
        const mb = (directorySize(dir) / 1024 / 1024).toFixed(1);
        console.log(`[renderer] staged at ${relative(REPO_ROOT, dir)} (${mb} MB)`);
        continue;
    }

    const stageDir = stage(name);
    await verify(name, stageDir);
    const mb = (directorySize(stageDir) / 1024 / 1024).toFixed(1);
    console.log(`[${name}] staged at ${relative(REPO_ROOT, stageDir)} (${mb} MB)`);
}

console.log('\nStaging complete.');
