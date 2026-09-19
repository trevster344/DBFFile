# Multi-user locking

This document describes the optional multi-user locking added to DBFFile, and the historical
dBase/FoxPro/Clipper scheme it implements.

## Background: how xBase locking actually works

The classic xBase multi-user model does **not** store a "locked" byte in the `.dbf` file. Record and
file locks are held by the operating system (DOS `SHARE`, later `LockFileEx` on Windows and
`fcntl` on POSIX) as **byte-range locks on the file itself**. This is why a lock held by another
application is invisible in the file contents, and why detecting it requires asking the OS.

The scheme is called **read-through locking**:

- **Reads** are issued at the real file offset, so they are never blocked by a record lock.
- **Write/record locks** are placed at `LockOffset + FileOffset`, where `LockOffset` is a huge
  arbitrary constant chosen so that a real data file never reaches it. A lock held there does not
  overlap any real data, so normal I/O continues to work.

Historically:

| Product | `LockOffset` |
| --- | --- |
| CA-Clipper (default) | `1,000,000,000` |
| FoxPro / SoftC | `4,000,000,000` |
| Clipper with `cdxlock.obj` (`.cdx`/`.idx` compatibility) | `4,000,000,000` |

dBase IV additionally offers an optional hidden `_DBASELOCK` field (change count, lock time, lock
date, user name). It is informational only — dBASE still uses OS locks — and DBFFile does not write
it. The header's `0x0E` "incomplete transaction" byte is a transaction marker, not a record lock.

## Ranges used by DBFFile

All ranges are placed at the lock offset, far beyond the real data:

| Lock | Range |
| --- | --- |
| File lock | `LockOffset` .. `LockOffset + max(headerLength, 32)` (the header region) |
| Record `i` | `LockOffset + headerLength + i * recordLength` .. `+ recordLength` |
| Memo file lock | `LockOffset` .. `LockOffset + 512` (the memo file's header) |

The default lock offset is `4,000,000,000` for FoxPro/VFP files (`0x30`, `0xf5`) and
`1,000,000,000` for dBASE/Clipper files (`0x83`, `0x8b`). It can be overridden with the `lockOffset`
option.

Because the file lock covers only the header region, it does not overlap record ranges. A file lock
therefore blocks reads and writes through DBFFile's own enforcement, while leaving the OS-level
record ranges independent. This is deliberate: a reader can detect an exclusive file lock without
mistaking a record lock for one.

## Enforcement

Locking is **opt-in**. Pass `{locking: true}` to `open()` or `create()`:

- **Reads** (`readRecords`, iteration) are refused with an `EBUSY` `LockError` while another process
  holds a blocking **file** lock. Record locks do **not** block reads (read-through).
- **Writes** (`appendRecords`, `updateRecord`, `updateRecords`) are refused unless this instance
  holds the required lock:
  - `appendRecords` requires the **file** lock (`lockFile()`).
  - `updateRecord`/`updateRecords` require the **record** lock for each target (`lockRecord(i)`).
  - A foreign lock on the target range always raises `EBUSY`.
- Lock state is always **probed freshly from the OS** at the moment of the operation; it is never
  cached on the instance.

When `locking` is false (the default), the lock methods are still available but no automatic checks
are performed — the caller coordinates locking entirely.

### API

```typescript
await dbf.lockFile();                 // exclusive file lock
await dbf.unlockFile();
await dbf.lockRecord(i);              // exclusive record lock
await dbf.unlockRecord(i);
await dbf.lockRecord(i, {wait: true, timeoutMs: 5000}); // wait for a contended lock
await dbf.isFileLocked();             // fresh OS probe
await dbf.isRecordLocked(i);          // fresh OS probe
await dbf.lockMemoFile();             // memo file header lock
await dbf.unlockMemoFile();
await dbf.close();                    // release native handles
```

Locks are held by a native handle/fd kept open on the `DBFFile` instance, so they survive across
method calls. Call `close()` when finished to release the handle. Closing the process, or killing it,
releases all of its locks automatically — unlike an in-file flag, there are no stale locks.

## Platform implementation

The native bindings are loaded lazily through [koffi](https://koffi.dev), so importing the library
does not require the native dependency unless locking is used. If it is unavailable, locking methods
throw a clear `ENATIVE` `LockError`.

| Platform | Mechanism |
| --- | --- |
| Windows | `LockFileEx` / `UnlockFileEx`, on a dedicated `CreateFileW` handle |
| Linux | `fcntl(F_OFD_SETLK)` / `F_OFD_GETLK` (open-file-description locks) |
| macOS | `fcntl(F_SETLK)` / `F_GETLK` (traditional locks) |

### Why Linux uses OFD locks

Traditional POSIX `fcntl` record locks are associated with the *process*, and the kernel releases
**all** of a process's locks on a file as soon as the process closes **any** file descriptor for that
file. DBFFile's read/write paths open and close their own fds per operation, so with traditional
locks a held lock would be silently dropped the moment a read or write opened its fd. Linux's
open-file-description (OFD) locks (`F_OFD_SETLK`/`F_OFD_GETLK`) belong to the open file description
instead, so they survive those closes. OFD locks still conflict with traditional locks held by other
processes, so interoperability with Harbour/Clipper on Linux is preserved.

macOS has no OFD locks, so it uses traditional locks; on macOS a lock can be released early by an
unrelated `close()` in the same process. Windows (`LockFileEx`) and Linux (OFD) do not have this
limitation.

### Windows mandatory locks

Windows byte-range locks are **mandatory**: while a range is locked, other handles' I/O to those
bytes fails. DBFFile avoids any impact on normal I/O by placing every lock at the lock offset, far
beyond EOF, so real reads and writes at the data offsets are never inside a locked range. The
mandatory behaviour is in fact what makes conflict detection reliable against non-cooperating
applications that follow the xBase protocol.

### POSIX advisory, per-process locks

`fcntl` locks are **advisory** and **per-process**: two `DBFFile` instances in the same process do
not conflict with each other. Cross-process conflict detection works normally. This is a POSIX
limitation, not a DBFFile one.

## Interoperability

DBFFile's locks use the same ranges as the classic products, so an application that follows the
xBase locking protocol (FoxPro, dBASE, Clipper/Harbour) will conflict with DBFFile's locks and vice
versa, provided both use the same lock offset. If you need to interoperate with Clipper's default
scheme, pass `{lockOffset: 1_000_000_000}`. As with all byte-range locking, an application that
writes without taking a lock cannot be prevented from doing so.

## Testing

Because POSIX locks are per-process and Windows locks are per-handle, all conflict tests run in
separate worker processes (`test/lock-worker.ts`, spawned via `child_process.fork`). The suite
covers, among others:

- lost-update prevention under concurrent read-modify-write from several processes;
- foreign-lock detection and read-through (record locks do not block reads);
- file locks blocking lock-aware reads and writes;
- writes requiring an explicit lock when `locking` is enabled;
- waiting for a contended lock and proceeding after release;
- lock release when the holding process is killed;
- concurrent appends and concurrent memo appends from multiple processes.

Run with `npm run build && npm test`.
