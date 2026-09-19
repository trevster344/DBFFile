# Testing

DBFFile has three ways to run its test suite. The default (`npm test`) runs natively on the host
OS; the optional `npm run test:wsl` path runs the full suite inside WSL to exercise the POSIX
(`fcntl`) locking code, which the Windows path cannot reach.

## Prerequisites

```
npm install
```

`npm install` runs the package's `prepublish` script, which creates the `node_modules/dbffile`
self-reference symlink and builds `dist/`. If you install another package later, npm may prune that
symlink; re-create it with `npm run self-ref` before testing.

## Native suite (Windows, macOS, Linux)

```
npm run self-ref && npm run build && npm test
```

Or simply `npm test` if you have already built. The suite uses mocha and lives in `dist/test`
(compiled from `test/`). On Windows it exercises the `LockFileEx` locking path; on Linux it exercises
the POSIX `fcntl` path.

## WSL suite (optional, opt-in)

```
npm run test:wsl
```

This runs the **full suite inside WSL** in an isolated Linux-native workdir (`$HOME/dbffile-wsl` by
default). It never touches the Windows `node_modules`, so Windows test runs are unaffected.

Options (also available as environment variables):

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--distro <name>` | `WSL_DISTRO` | first non-docker distro | WSL distribution to use |
| `--workdir <path>` | `WSL_WORKDIR` | `$HOME/dbffile-wsl` | Linux workdir for the synced copy |
| `--grep <pattern>` | `WSL_GREP` | (full suite) | Only run matching mocha tests |
| `--install` | `WSL_INSTALL=1` | off | Run `npm ci` in the workdir if its `node_modules` is missing |
| `--require` | `WSL_REQUIRE=1` | off | Exit non-zero (instead of skipping) when WSL/Node/deps are unavailable |

The script:
1. Detects WSL and a distribution (skips cleanly if WSL is not available).
2. Checks for Node in the distro, and prints setup instructions if it is missing.
3. Syncs the repository into the isolated workdir with `rsync` (source only; `node_modules` is
   preserved across syncs and the Windows tree is never written).
4. Runs `npm run self-ref && npm run build && npm test` in the workdir.

### One-time WSL setup

Inside WSL:

```bash
# 1. Install Node 22 (if missing)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install the workdir dependencies (requires internet access from WSL)
npm run test:wsl -- --install
#   or manually:  cd "$HOME/dbffile-wsl" && npm ci
```

### Offline setup (no internet from WSL)

If WSL cannot reach the npm registry, build a Linux `node_modules` on the host (which has internet)
and seed the workdir:

```bash
# On Windows, in a scratch directory containing package.json and package-lock.json:
npm install --os=linux --cpu=x64 --ignore-scripts
# then copy that node_modules/ into the WSL workdir, e.g.:
#   rsync -a node_modules/ <distro>:~/dbffile-wsl/node_modules/
```

`koffi` ships its Linux prebuilt as the optional dependency `@koromix/koffi-linux-x64`, so no
compiler is needed.

## Docker alternative

If Docker is available and WSL is not, the same Linux coverage can be obtained with:

```
docker run --rm -v "D:\path\to\DBFFile:/work" -w /work node:22-bookworm \
  bash -lc "npm ci && npm run self-ref && npm run build && npm test"
```

## What each path validates

| Path | Locking backend exercised |
| --- | --- |
| `npm test` on Windows | `LockFileEx` |
| `npm test` on Linux/macOS | `fcntl` (OFD on Linux) |
| `npm run test:wsl` | `fcntl` (OFD on Linux) via WSL |

The locking tests spawn separate worker processes (`test/lock-worker.ts`) because POSIX locks are
per-process and Windows locks are per-handle.
