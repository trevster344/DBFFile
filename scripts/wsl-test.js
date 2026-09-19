#!/usr/bin/env node
'use strict';

// Opt-in test path that runs the full test suite inside WSL, to exercise the POSIX (fcntl) code
// paths. It is intentionally lightweight: it detects WSL and Node, syncs the repository into an
// isolated Linux-native workdir, and tells the developer what to do when something is missing. It
// never modifies the Windows node_modules, so Windows test runs are unaffected.

const {spawnSync} = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKDIR = '$HOME/dbffile-wsl';

function parseArgs(argv) {
    const opts = {
        distro: process.env.WSL_DISTRO || '',
        workdir: process.env.WSL_WORKDIR || DEFAULT_WORKDIR,
        grep: process.env.WSL_GREP || '',
        require: process.env.WSL_REQUIRE === '1',
        install: process.env.WSL_INSTALL === '1',
        help: false,
    };
    for (let i = 2; i < argv.length; ++i) {
        const arg = argv[i];
        if (arg === '--distro') opts.distro = argv[++i] || '';
        else if (arg === '--workdir') opts.workdir = argv[++i] || '';
        else if (arg === '--grep') opts.grep = argv[++i] || '';
        else if (arg === '--require') opts.require = true;
        else if (arg === '--install') opts.install = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else { console.error(`Unknown option: ${arg}`); opts.help = true; }
    }
    // Allow `~/foo` to be written naturally; `$HOME` survives quoting in the shell command.
    if (opts.workdir.startsWith('~/')) opts.workdir = '$HOME/' + opts.workdir.slice(2);
    return opts;
}

function usage() {
    console.log(`Usage: npm run test:wsl [-- options]

Runs the full DBFFile test suite inside WSL (Linux), in an isolated workdir.

Options:
  --distro <name>    WSL distribution to use (default: $WSL_DISTRO, else the first non-docker distro)
  --workdir <path>   Linux workdir for the synced copy (default: $WSL_WORKDIR, else $HOME/dbffile-wsl)
  --grep <pattern>   Only run tests matching the mocha --grep pattern (default: full suite)
  --install          Run 'npm ci' in the workdir when its node_modules is missing
  --require          Exit non-zero (instead of skipping) when WSL/Node/deps are unavailable

Environment: WSL_DISTRO, WSL_WORKDIR, WSL_GREP, WSL_INSTALL=1, WSL_REQUIRE=1`);
}

function wslAvailable() {
    const result = spawnSync('wsl.exe', ['-l', '-q']);
    return !result.error;
}

function listDistros() {
    const result = spawnSync('wsl.exe', ['-l', '-q']);
    if (result.error) return [];
    // wsl.exe writes UTF-16LE; Node reads the raw bytes, so decode explicitly.
    const text = (result.stdout || Buffer.alloc(0)).toString('utf16le');
    return text.split(/\r?\n/)
        .map(line => line.replace(/\0/g, '').trim())
        .filter(Boolean)
        .filter(name => name.toLowerCase() !== 'docker-desktop');
}

function capture(distro, command) {
    const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', command], {encoding: 'utf8'});
    return {code: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim()};
}

function run(distro, command) {
    const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', command], {stdio: 'inherit'});
    return result.status === null ? 1 : result.status;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function probeNode(distro) {
    const result = capture(distro, 'if command -v node >/dev/null 2>&1; then node -v; else echo NO_NODE; fi');
    return result.stdout.includes('NO_NODE') ? null : result.stdout;
}

function toWslPath(distro, winPath) {
    const result = capture(distro, `wslpath -a ${shellQuote(winPath)}`);
    return result.code === 0 ? result.stdout : null;
}

function hasNodeModules(distro, workdir) {
    return capture(distro, `test -d "${workdir}/node_modules" && echo YES || echo NO`).stdout.includes('YES');
}

function setupInstructions(distro, workdir) {
    console.log(`
WSL is available, but not ready to run the tests yet. In WSL ('${distro}'):

  # 1. Install Node 22 (if missing)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # 2. Install the workdir dependencies (requires WSL internet)
  npm run test:wsl -- --install
  #   or manually:  cd "${workdir}" && npm ci

  # 3. Run the full suite
  npm run test:wsl

Offline alternative: if WSL has no internet, build a Linux node_modules on
Windows (which has internet) and copy it into the workdir:

  # on Windows, in a scratch directory:
  npm install --os=linux --cpu=x64 --ignore-scripts
  # then copy that node_modules/ into ${workdir}/
`);
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        usage();
        return 0;
    }

    if (!wslAvailable()) {
        console.log('WSL is not available on this machine - skipping the WSL test run.');
        return 0;
    }

    const distros = listDistros();
    if (!distros.length) {
        console.log('No suitable WSL distribution found - skipping the WSL test run.');
        return opts.require ? 1 : 0;
    }
    const distro = opts.distro || distros[0];

    const nodeVersion = probeNode(distro);
    if (!nodeVersion) {
        console.log(`WSL distro '${distro}' does not have Node installed.`);
        setupInstructions(distro, opts.workdir);
        return opts.require ? 1 : 0;
    }
    console.log(`Running tests in WSL distro '${distro}' (Node ${nodeVersion}).`);

    const wslRepo = toWslPath(distro, REPO_ROOT);
    if (!wslRepo) {
        console.error(`Could not convert the repository path '${REPO_ROOT}' to a WSL path.`);
        return 1;
    }

    // Sync the source into the isolated workdir. node_modules is excluded so the workdir's Linux
    // dependencies are preserved across syncs, and --delete (without --delete-excluded) never
    // touches them. The Windows tree is never written to.
    console.log(`Syncing into ${opts.workdir} ...`);
    const syncCommand = [
        `mkdir -p "${opts.workdir}"`,
        `rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude '*.log' "${wslRepo}/" "${opts.workdir}/"`,
    ].join(' && ');
    if (run(distro, syncCommand) !== 0) {
        console.error('Failed to sync the repository into the WSL workdir.');
        return 1;
    }

    if (!hasNodeModules(distro, opts.workdir)) {
        if (opts.install) {
            console.log('Installing Linux dependencies in the WSL workdir (npm ci) ...');
            if (run(distro, `cd "${opts.workdir}" && npm ci`) !== 0) {
                console.error('npm ci failed in the WSL workdir.');
                setupInstructions(distro, opts.workdir);
                return 1;
            }
        }
        else {
            console.log(`The WSL workdir '${opts.workdir}' has no node_modules.`);
            setupInstructions(distro, opts.workdir);
            return opts.require ? 1 : 0;
        }
    }

    const testCommand = opts.grep
        ? `cd "${opts.workdir}" && npm run self-ref && npm run build && npm test -- --grep ${shellQuote(opts.grep)}`
        : `cd "${opts.workdir}" && npm run self-ref && npm run build && npm test`;
    console.log('Running the full test suite in WSL ...\n');
    return run(distro, testCommand);
}

process.exit(main());
