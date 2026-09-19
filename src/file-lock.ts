import * as fs from 'fs';




/**
 * Byte-range file locking compatible with the historical xBase multi-user locking scheme.
 *
 * The classic dBase III+/IV, FoxPro and Clipper multi-user model is "read-through locking":
 * reads are issued at the real file offset, while write/record locks are placed at a large
 * synthetic offset (`LockOffset + FileOffset`) so that reads are never blocked by a record
 * lock. A whole-file lock is a lock on the header region at `LockOffset`. This module exposes
 * exactly those primitives; the DBFFile class maps record numbers and memo values onto them.
 *
 * On Windows the underlying `LockFileEx` locks are mandatory, but because they are placed far
 * beyond EOF they do not interfere with normal reads/writes at the real offsets. On POSIX the
 * underlying `fcntl` locks are advisory and per-process (locks held by the same process never
 * conflict), which is why conflict tests must use separate processes.
 *
 * The native bindings are loaded lazily through `koffi`, so importing this library does not
 * require the native dependency to be present unless locking is actually used.
 */




/** The direction of a byte-range lock. */
export type LockMode = 'read' | 'write';




/** A half-open byte range `[start, start + length)`. */
export interface LockRange {
    start: number;
    length: number;
}




/** The result of probing a byte range for a conflicting lock. */
export interface LockProbeResult {

    /** Whether the range is currently locked (by this process or another). */
    locked: boolean;

    /** The PID of the owning process, when the platform reports it (POSIX only). */
    pid?: number;
}




/** Options controlling how a lock is acquired. */
export interface LockOptions {

    /** When true, wait for the lock to become available instead of failing immediately. Defaults to false. */
    wait?: boolean;

    /** Maximum time to wait for a lock, in milliseconds. Defaults to 10000. */
    timeoutMs?: number;
}




/** Error thrown when a lock cannot be acquired, or when the native locking backend is unavailable. */
export class LockError extends Error {
    code: string;
    constructor(message: string, code: string) {
        super(message);
        this.name = 'LockError';
        this.code = code;
    }
}




const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;




//-------------------- Native backend abstraction starts here --------------------
interface NativeLockProvider {
    lock(range: LockRange, mode: LockMode): Promise<void>;
    unlock(range: LockRange): Promise<void>;
    probe(range: LockRange): Promise<LockProbeResult>;
    close(): Promise<void>;
}




/**
 * Holds OS byte-range locks on a single file, on behalf of a DBFFile instance. Locks persist across
 * method calls (the underlying handle/fd is kept open) until unlocked or until `close()` is called.
 * Callers should call `close()` when finished to release the native handle.
 */
export class FileLocker {
    private provider: NativeLockProvider;
    private held: LockRange[] = [];
    private closed = false;

    constructor(filePath: string) {
        this.provider = createProvider(filePath);
    }

    /** Whether native byte-range locking is available on this platform. */
    static isSupported(): boolean {
        return process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin';
    }

    /** Acquires a lock over the given range, failing (or waiting) if it conflicts with an existing lock. */
    async lock(range: LockRange, mode: LockMode = 'write', options: LockOptions = {}): Promise<void> {
        this.assertOpen();
        if (options.wait) {
            const timeout = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
            const deadline = Date.now() + timeout;
            for (;;) {
                try {
                    await this.provider.lock(range, mode);
                    break;
                }
                catch (err) {
                    if (!(err instanceof LockError) || err.code !== 'EBUSY') throw err;
                    if (Date.now() >= deadline) {
                        throw new LockError(`Timed out after ${timeout}ms waiting for a lock on bytes ${range.start}..${range.start + range.length}`, 'ETIMEDOUT');
                    }
                    await delay(POLL_INTERVAL_MS);
                }
            }
        }
        else {
            await this.provider.lock(range, mode);
        }
        this.held.push({start: range.start, length: range.length});
    }

    /** Releases the lock over the given range. */
    async unlock(range: LockRange): Promise<void> {
        this.assertOpen();
        await this.provider.unlock(range);
        this.held = this.held.filter(h => !rangesOverlap(h, range));
    }

    /**
     * Freshly probes the OS lock table for a conflicting lock on the given range. Locks held by this
     * instance are reported as locked without hitting the OS (POSIX does not report a process's own
     * locks as conflicts).
     */
    async probe(range: LockRange): Promise<LockProbeResult> {
        this.assertOpen();
        if (this.holdsRange(range)) return {locked: true};
        return this.provider.probe(range);
    }

    /** Whether this instance currently holds a lock overlapping the given range. */
    holdsRange(range: LockRange): boolean {
        return this.held.some(h => rangesOverlap(h, range));
    }

    /** Releases all locks held by this instance and closes the native handle. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.provider.close();
        this.held = [];
    }

    private assertOpen(): void {
        if (this.closed) throw new LockError('This file locker has been closed', 'ECLOSED');
    }
}




function rangesOverlap(a: LockRange, b: LockRange): boolean {
    return a.start < b.start + b.length && b.start < a.start + a.length;
}




function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}




function createProvider(filePath: string): NativeLockProvider {
    switch (process.platform) {
        case 'win32':
            return new WindowsLockProvider(filePath);
        case 'linux':
            return new PosixLockProvider(filePath, 'linux');
        case 'darwin':
            return new PosixLockProvider(filePath, 'darwin');
        default:
            throw new LockError(`Native byte-range locking is not supported on platform '${process.platform}'`, 'EPLATFORM');
    }
}




//-------------------- Windows implementation (LockFileEx) --------------------
interface WindowsApi {
    createFile(path: string): unknown;
    isInvalidHandle(handle: unknown): boolean;
    closeHandle(handle: unknown): void;
    lock(handle: unknown, range: LockRange, exclusive: boolean): boolean;
    unlock(handle: unknown, range: LockRange): boolean;
    getLastError(): number;
}




const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const FILE_SHARE_DELETE = 0x00000004;
const OPEN_EXISTING = 3;
const LOCKFILE_FAIL_IMMEDIATELY = 0x00000001;
const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002;
const ERROR_LOCK_VIOLATION = 33;
const ERROR_SHARING_VIOLATION = 36;




let windowsApi: WindowsApi | undefined;




function getWindowsApi(): WindowsApi {
    if (windowsApi) return windowsApi;
    const koffi = loadKoffi();
    const kernel32 = koffi.load('kernel32.dll');
    const overlapped = koffi.struct('OVERLAPPED', {
        Internal: 'uintptr_t',
        InternalHigh: 'uintptr_t',
        Offset: 'uint32',
        OffsetHigh: 'uint32',
        hEvent: 'void *',
    });
    const createFileW = kernel32.func('__stdcall', 'CreateFileW', 'intptr_t', [
        'str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t',
    ]);
    const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t']);
    const lockFileEx = kernel32.func('__stdcall', 'LockFileEx', 'bool', [
        'intptr_t', 'uint32', 'uint32', 'uint32', 'uint32', koffi.inout(koffi.pointer(overlapped)),
    ]);
    const unlockFileEx = kernel32.func('__stdcall', 'UnlockFileEx', 'bool', [
        'intptr_t', 'uint32', 'uint32', 'uint32', koffi.inout(koffi.pointer(overlapped)),
    ]);
    const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);

    const toOverlapped = (offset: number, _length: number) => ({
        Internal: 0,
        InternalHigh: 0,
        Offset: offset >>> 0,
        OffsetHigh: Math.floor(offset / 0x100000000) >>> 0,
        hEvent: null,
    });

    const openFile = (path: string, access: number): unknown => {
        return createFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null, OPEN_EXISTING, 0, 0);
    };

    const isInvalid = (handle: unknown): boolean => Number(handle) === -1;

    windowsApi = {
        createFile(path: string): unknown {
            let handle = openFile(path, GENERIC_READ | GENERIC_WRITE);
            if (isInvalid(handle)) handle = openFile(path, GENERIC_READ);
            return handle;
        },
        isInvalidHandle(handle: unknown): boolean {
            return isInvalid(handle);
        },
        closeHandle(handle: unknown): void {
            closeHandle(handle as any);
        },
        lock(handle: unknown, range: LockRange, exclusive: boolean): boolean {
            const flags = (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0) | LOCKFILE_FAIL_IMMEDIATELY;
            return lockFileEx(handle as any, flags, 0, range.length >>> 0, Math.floor(range.length / 0x100000000) >>> 0, toOverlapped(range.start, range.length));
        },
        unlock(handle: unknown, range: LockRange): boolean {
            return unlockFileEx(handle as any, 0, range.length >>> 0, Math.floor(range.length / 0x100000000) >>> 0, toOverlapped(range.start, range.length));
        },
        getLastError(): number {
            return getLastError();
        },
    };
    return windowsApi;
}




class WindowsLockProvider implements NativeLockProvider {
    private handle: unknown;
    private readonly path: string;

    constructor(path: string) {
        this.path = path;
    }

    private ensureHandle(): unknown {
        const api = getWindowsApi();
        if (this.handle === undefined) {
            const handle = api.createFile(this.path);
            if (api.isInvalidHandle(handle)) {
                throw new LockError(`Unable to open '${this.path}' for locking (Win32 error ${api.getLastError()})`, 'EOPEN');
            }
            this.handle = handle;
        }
        return this.handle;
    }

    async lock(range: LockRange, mode: LockMode): Promise<void> {
        const api = getWindowsApi();
        const handle = this.ensureHandle();
        if (!api.lock(handle, range, mode === 'write')) {
            const err = api.getLastError();
            if (err === ERROR_LOCK_VIOLATION || err === ERROR_SHARING_VIOLATION) {
                throw new LockError(`Bytes ${range.start}..${range.start + range.length} are locked by another process`, 'EBUSY');
            }
            throw new LockError(`Failed to lock bytes ${range.start}..${range.start + range.length} (Win32 error ${err})`, 'ELOCK');
        }
    }

    async unlock(range: LockRange): Promise<void> {
        if (this.handle === undefined) return;
        getWindowsApi().unlock(this.handle, range);
    }

    async probe(range: LockRange): Promise<LockProbeResult> {
        const api = getWindowsApi();
        const handle = api.createFile(this.path);
        if (api.isInvalidHandle(handle)) {
            throw new LockError(`Unable to open '${this.path}' for lock probing (Win32 error ${api.getLastError()})`, 'EOPEN');
        }
        try {
            if (api.lock(handle, range, true)) {
                api.unlock(handle, range);
                return {locked: false};
            }
            const err = api.getLastError();
            if (err === ERROR_LOCK_VIOLATION || err === ERROR_SHARING_VIOLATION) return {locked: true};
            throw new LockError(`Failed to probe bytes ${range.start}..${range.start + range.length} (Win32 error ${err})`, 'ELOCK');
        }
        finally {
            api.closeHandle(handle);
        }
    }

    async close(): Promise<void> {
        if (this.handle !== undefined) {
            getWindowsApi().closeHandle(this.handle);
            this.handle = undefined;
        }
    }
}




//-------------------- POSIX implementation (fcntl) --------------------
interface PosixApi {
    setLock(fd: number, range: LockRange, mode: LockMode): void;
    clearLock(fd: number, range: LockRange): void;
    getLock(fd: number, range: LockRange): LockProbeResult;
}




const F_RDLCK = {linux: 0, darwin: 1} as const;
const F_WRLCK = {linux: 1, darwin: 3} as const;
const F_UNLCK = {linux: 2, darwin: 2} as const;

// Linux uses open-file-description (OFD) locks rather than traditional process-associated locks.
// Traditional fcntl locks are released when *any* file descriptor for the file is closed by the
// process, which is exactly what DBFFile's read/write paths do (they open and close their own fds).
// OFD locks belong to the open file description instead, so they survive those closes while still
// conflicting with traditional locks held by other processes (e.g. Harbour/Clipper on Linux).
const F_GETLK = {linux: 36, darwin: 7} as const; // Linux: F_OFD_GETLK
const F_SETLK = {linux: 37, darwin: 8} as const; // Linux: F_OFD_SETLK
const SEEK_SET = 0;
const EACCES = 13;
const EAGAIN_LINUX = 11;
const EAGAIN_DARWIN = 35;




const posixApis: Record<string, PosixApi> = {};




function getPosixApi(platform: 'linux' | 'darwin'): PosixApi {
    if (posixApis[platform]) return posixApis[platform];
    const koffi = loadKoffi();
    const lib = koffi.load(platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6');

    // The layout of `struct flock` differs between Linux and macOS, so each is declared separately.
    // koffi applies the platform's natural alignment when laying out the struct.
    const flock = platform === 'linux'
        ? koffi.struct('flock', {
            l_type: 'short',
            l_whence: 'short',
            l_start: 'int64',
            l_len: 'int64',
            l_pid: 'int',
        })
        : koffi.struct('flock', {
            l_start: 'int64',
            l_len: 'int64',
            l_pid: 'int',
            l_type: 'short',
            l_whence: 'short',
        });

    const fcntl = lib.func('fcntl', 'int', ['int', 'int', koffi.inout(koffi.pointer(flock))]);

    const makeFlock = (range: LockRange, type: number) => platform === 'linux'
        ? {l_type: type, l_whence: SEEK_SET, l_start: range.start, l_len: range.length, l_pid: 0}
        : {l_start: range.start, l_len: range.length, l_pid: 0, l_type: type, l_whence: SEEK_SET};

    const call = (fd: number, cmd: number, range: LockRange, type: number) => {
        const ret = fcntl(fd, cmd, makeFlock(range, type));
        if (ret === -1) {
            const err = koffi.errno();
            if (err === EACCES || err === EAGAIN_LINUX || err === EAGAIN_DARWIN) {
                throw new LockError(`Bytes ${range.start}..${range.start + range.length} are locked by another process`, 'EBUSY');
            }
            throw new LockError(`fcntl failed for bytes ${range.start}..${range.start + range.length} (errno ${err})`, 'ELOCK');
        }
    };

    posixApis[platform] = {
        setLock(fd, range, mode) {
            call(fd, F_SETLK[platform], range, mode === 'write' ? F_WRLCK[platform] : F_RDLCK[platform]);
        },
        clearLock(fd, range) {
            call(fd, F_SETLK[platform], range, F_UNLCK[platform]);
        },
        getLock(fd, range): LockProbeResult {
            const info = makeFlock(range, F_WRLCK[platform]);
            const ret = fcntl(fd, F_GETLK[platform], info);
            if (ret === -1) {
                const err = koffi.errno();
                throw new LockError(`fcntl(F_GETLK) failed for bytes ${range.start}..${range.start + range.length} (errno ${err})`, 'ELOCK');
            }
            if (info.l_type === F_UNLCK[platform]) return {locked: false};
            return {locked: true, pid: info.l_pid};
        },
    };
    return posixApis[platform];
}




class PosixLockProvider implements NativeLockProvider {
    private fd: number | undefined;
    private readonly path: string;
    private readonly platform: 'linux' | 'darwin';

    constructor(path: string, platform: 'linux' | 'darwin') {
        this.path = path;
        this.platform = platform;
    }

    private ensureFd(): number {
        if (this.fd === undefined) {
            try {
                this.fd = fs.openSync(this.path, 'r+');
            }
            catch {
                this.fd = fs.openSync(this.path, 'r');
            }
        }
        return this.fd;
    }

    async lock(range: LockRange, mode: LockMode): Promise<void> {
        getPosixApi(this.platform).setLock(this.ensureFd(), range, mode);
    }

    async unlock(range: LockRange): Promise<void> {
        if (this.fd === undefined) return;
        getPosixApi(this.platform).clearLock(this.fd, range);
    }

    async probe(range: LockRange): Promise<LockProbeResult> {
        return getPosixApi(this.platform).getLock(this.ensureFd(), range);
    }

    async close(): Promise<void> {
        if (this.fd !== undefined) {
            fs.closeSync(this.fd);
            this.fd = undefined;
        }
    }
}




//-------------------- Lazy native binding loader --------------------
let koffiModule: any;




function loadKoffi(): any {
    if (koffiModule) return koffiModule;
    try {
        koffiModule = require('koffi');
    }
    catch (err) {
        throw new LockError(`Native byte-range locking requires the optional 'koffi' dependency: ${(err as Error).message}`, 'ENATIVE');
    }
    return koffiModule;
}
