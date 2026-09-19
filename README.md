# DBFFile

### Summary

Read and write .dbf (dBase III, dBase IV, FoxPro and Visual FoxPro) files in Node.js:

- Supported field types:
  - `C` (string)
  - `N` (numeric)
  - `F` (float)
  - `Y` (currency)
  - `I` (integer)
  - `L` (logical)
  - `D` (date)
  - `T` (datetime)
  - `B` (double)
  - `M` (memo) — read **and write**, supporting dBase III (version 0x83), dBase IV (version 0x8b), VFP9 (version 0x30)
    and FoxPro 2 (version 0xf5) memo files. Memo writes reuse an existing block chain when the new value fits, otherwise
    they append a new chain (matching the classic xBase products).
- 'Loose' read mode - tries to read any kind of .dbf file without complaining. Unsupported field types are simply skipped.
- Supports Clipper long character fields (`C` fields longer than 255 bytes), with the following limitations:
  - read-only (can't create/write DBF files with long character fields)
  - only detected when the standard field sizes don't match the header's record length, but the 16-bit sizes do
- Can open an existing .dbf file
  - Can access all field descriptors
  - Can access total record count
  - Can access date of last update
  - Can read records using async iteration
  - Can read records in arbitrary-sized batches
  - Can include deleted records in results
  - Supports very large files
- Can create a new .dbf file
  - Can use field descriptors from a user-specified object of from another instance
- Can append records to an existing .dbf file
  - Supports very large files
- Can update records in place
  - `updateRecord(index, record)` and `updateRecords([{index, record}, ...])` write only the affected record bytes
    (and any new memo data); the file is not rewritten
- Optional multi-user locking, compatible with dBase/FoxPro/Clipper
  - native byte-range locks (Windows `LockFileEx`, POSIX `fcntl`) using the historical xBase "read-through" lock offsets
  - file locks and record locks, probed freshly from the OS on every operation (never cached)
  - opt-in via `{locking: true}`, at which point writes require an explicit lock and lock-aware reads are refused while a
    blocking file lock is held; see [LOCKING.md](./LOCKING.md)
- CDX compound index support (read and write), including the production `.cdx` that shares the DBF's name
  - opt in with `{cdx: 0x30}` (Visual FoxPro 9) or `{cdx: 0xf5}` (FoxPro 2.x)
  - read records in tag order (`readRecords({index})`), seek exact keys (`seek`), create tags with key/FOR
    expressions, and rebuild with `reindex()`
  - open with `{expressionCompat: 'codebase'}` for indexes built by Sequiter CodeBase (whose `RIGHT()` behaves
    like `LEFT()`); reindexing refuses to clobber an index whose semantics don't match
  - see [CDX.md](./CDX.md)
- Can specify character encodings either per-file or per-field.
  - the default encoding is `'ISO-8859-1'` (also known as latin 1)
  - example per-file encoding: `DBFFile.open(<path>, {encoding: 'EUC-JP'})`
  - example per-field encoding: `DBFFile.open(<path>, {encoding: {default: 'latin1', FIELD_XYZ: 'EUC-JP'}})`
  - supported encodings are listed [here](https://github.com/ashtuchkin/iconv-lite/wiki/Supported-Encodings).
- All operations are asynchronous and return a promise

### Installation

`npm install dbffile` or `yarn add dbffile`

### Example: read all records in a .dbf file using for-await-of

```javascript
import {DBFFile} from 'dbffile';

async function iterativeRead() {
    let dbf = await DBFFile.open('<full path to .dbf file>');
    console.log(`DBF file contains ${dbf.recordCount} records.`);
    console.log(`Field names: ${dbf.fields.map(f => f.name).join(', ')}`);
    for await (const record of dbf) console.log(record);
}
```

### Example: reading a batch of records from a .dbf file

```javascript
import {DBFFile} from 'dbffile';

async function batchRead() {
    let dbf = await DBFFile.open('<full path to .dbf file>');
    console.log(`DBF file contains ${dbf.recordCount} records.`);
    console.log(`Field names: ${dbf.fields.map(f => f.name).join(', ')}`);
    let records = await dbf.readRecords(100); // batch-reads up to 100 records, returned as an array
    for (let record of records) console.log(record);
}
```

### Example: writing a .dbf file

```javascript
import {DBFFile} from 'dbffile';

async function batchWrite() {
    let fieldDescriptors = [
        { name: 'fname', type: 'C', size: 255 },
        { name: 'lname', type: 'C', size: 255 }
    ];

    let records = [
        { fname: 'Joe', lname: 'Bloggs' },
        { fname: 'Mary', lname: 'Smith' }
    ];

    let dbf = await DBFFile.create('<full path to .dbf file>', fieldDescriptors);
    console.log('DBF file created.');
    await dbf.appendRecords(records);
    console.log(`${records.length} records added.`);
}
```

### Example: writing a .dbf file with memo fields

```javascript
import {DBFFile} from 'dbffile';

async function memoWrite() {
    let fieldDescriptors = [
        { name: 'id', type: 'N', size: 10 },
        { name: 'notes', type: 'M', size: 4 } // memo field: size 4 for VFP9 (0x30), 10 otherwise
    ];

    // Memo fields require a memo-capable file version: 0x83, 0x8b, 0x30 or 0xf5.
    let dbf = await DBFFile.create('<full path to .dbf file>', fieldDescriptors, {fileVersion: 0x30});
    await dbf.appendRecords([
        { id: 1, notes: 'a memo value' },
        { id: 2, notes: 'a much longer memo value that spans multiple blocks...' }
    ]);
}
```

### Example: updating records in place

```javascript
import {DBFFile} from 'dbffile';

async function updateInPlace() {
    let dbf = await DBFFile.open('<full path to .dbf file>');

    // Update one record by index. Only that record's bytes are written.
    await dbf.updateRecord(3, { id: 4, notes: 'replacement value' });

    // Update several records in one call.
    await dbf.updateRecords([
        { index: 5, record: { id: 6, notes: 'first' } },
        { index: 9, record: { id: 10, notes: 'second' } }
    ]);
}
```

### Example: multi-user locking (dBase/FoxPro/Clipper compatible)

```javascript
import {DBFFile} from 'dbffile';

async function lockedUpdate() {
    // Locking is opt-in. With {locking: true}, writes require an explicit lock and lock-aware
    // reads are refused while another process holds a blocking file lock.
    let dbf = await DBFFile.open('<full path to .dbf file>', {locking: true});

    // Lock a single record, read-modify-write, then release.
    await dbf.lockRecord(3);
    try {
        let record = (await dbf.readRecords(4))[3];
        await dbf.updateRecord(3, {...record, notes: 'updated safely'});
    }
    finally {
        await dbf.unlockRecord(3);
    }

    // Whole-file operations (e.g. appends) take the file lock instead.
    await dbf.lockFile();
    try {
        await dbf.appendRecords([{id: 99, notes: 'appended'}]);
    }
    finally {
        await dbf.unlockFile();
    }

    // Lock state can be probed freshly at any time.
    console.log('record 3 locked?', await dbf.isRecordLocked(3));

    await dbf.close(); // releases any native lock handles
}
```

### Loose Read Mode

Not all versions and variants of .dbf file are supported by this library. Normally, when an unsupported file version or
field type is encountered, an error is reported and reading halts immediately. This has been a problem for users who
just want to recover data from old .dbf files, and would rather not write a PR or wait for one that adds the missing
file/field support.

A more forgiving approach to reading .dbf files is now provided by passing the option `{readMode: 'loose'}` to the
`DBFFile.open(...)` function. In this mode, unrecognised file versions, unsupported field types, and missing memo files
are all tolerated. Unsupported/missing field types are still present in the `fields` field descriptors, but will be missing in
the record data returned by the `readRecords(...)` method.


### API

The module exports the `DBFFile` class, which has the following shape:

```typescript
/** Represents a DBF file. */
class DBFFile {

    /** Opens an existing DBF file. */
    static open(path: string, options?: OpenOptions): Promise<DBFFile>;

    /** Creates a new DBF file with no records. */
    static create(path: string, fields: FieldDescriptor[], options?: CreateOptions): Promise<DBFFile>;

    /** Full path to the DBF file. */
    path: string;

    /** Total number of records in the DBF file (NB: includes deleted records). */
    recordCount: number;

    /** Date of last update as recorded in the DBF file header. */
    dateOfLastUpdate: Date;

    /** Metadata for all fields defined in the DBF file. */
    fields: FieldDescriptor[];

    /** Reads a subset of records from this DBF file. The current read position is remembered between calls. */
    readRecords(maxCount?: number): Promise<object[]>;

    /** Appends the specified records to this DBF file. */
    appendRecords(records: object[]): Promise<DBFFile>;

    /** Updates a single record in place, at the given zero-based index. */
    updateRecord(index: number, record: object): Promise<DBFFile>;

    /** Updates multiple records in place. */
    updateRecords(updates: {index: number, record: object}[]): Promise<DBFFile>;

    /** Places an exclusive lock on the file's header region. */
    lockFile(options?: LockOptions): Promise<void>;
    unlockFile(): Promise<void>;

    /** Places/releases an exclusive lock on a single record's byte range. */
    lockRecord(index: number, options?: LockOptions): Promise<void>;
    unlockRecord(index: number): Promise<void>;

    /** Places/releases an exclusive lock on the memo file's header region. */
    lockMemoFile(options?: LockOptions): Promise<void>;
    unlockMemoFile(): Promise<void>;

    /** Freshly probes the OS lock table for a file/record lock. */
    isFileLocked(): Promise<boolean>;
    isRecordLocked(index: number): Promise<boolean>;

    /** Releases any native lock handles held by this instance. */
    close(): Promise<void>;

    /** Iterates over each record in this DBF file. */
    [Symbol.asyncIterator](): AsyncGenerator<object>;
}

/** Metadata describing a single field in a DBF file. */
interface FieldDescriptor {

    /** The name of the field. Must be no longer than 10 characters. */
    name: string;

    /**
     * The single-letter code for the field type.
     * C=string, N=numeric, F=float, I=integer, L=logical, D=date, M=memo.
     */
    type: 'C' | 'N' | 'F' | 'Y' | 'L' | 'D' | 'I' | 'M' | 'T' | 'B';

    /** The size of the field in bytes. */
    size: number;

    /** The number of decimal places. Optional; only used for some field types. */
    decimalPlaces?: number;
}

/** Options that may be passed to `DBFFile.open`. */
interface OpenOptions {
    /**
     * The behavior to adopt when unsupported file versions or field types are encountered. The following values are
     * supported, with the default being 'strict':
     * - 'strict': when an unsupported file version or field type is encountered, stop reading the file immediately and
     *   issue a descriptive error.
     * - 'loose': ignore unrecognised file versions, unsupported field types, and missing memo files and attempt to
     *   continue reading the file. Any unsupported field types encountered will be present in field descriptors but
     *   missing from read records.
     */
    readMode?: 'strict' | 'loose'

    /** The character encoding(s) to use when reading the DBF file. Defaults to ISO-8859-1. */
    encoding?: Encoding;

    /**
     * Indicates whether deleted records should be included in results when reading records. Defaults to false.
     * Deleted records have the property `[DELETED]: true`, using the `DELETED` symbol exported from this library.
     */
    includeDeletedRecords?: boolean;

    /**
     * Enables lock-aware behaviour. When true, lock-aware reads are refused while another process holds a
     * blocking (file) lock, and writes are refused unless this instance holds the appropriate record/file lock.
     * Lock state is always probed freshly from the OS; it is never cached. Defaults to false.
     */
    locking?: boolean;

    /**
     * Overrides the synthetic xBase lock offset used to place write locks beyond the real data. Defaults to
     * 4,000,000,000 for FoxPro/VFP files and 1,000,000,000 for dBASE/Clipper files.
     */
    lockOffset?: number;
}

/** Options that may be passed to `DBFFile.create`. */
interface CreateOptions {

    /** The file version to create. Currently versions 0x03, 0x83, 0x8b, 0x30 and 0xf5 are supported. Defaults to 0x03. */
    fileVersion?: FileVersion;

    /** The character encoding(s) to use when writing the DBF file. Defaults to ISO-8859-1. */
    encoding?: Encoding;

    /** The block size to use for a newly created memo file. Defaults to 512. */
    memoBlockSize?: number;

    /** Enables lock-aware behaviour on the created instance. See `OpenOptions.locking`. Defaults to false. */
    locking?: boolean;

    /** Overrides the synthetic xBase lock offset. See `OpenOptions.lockOffset`. */
    lockOffset?: number;
}

/** Options accepted by the locking methods. */
interface LockOptions {

    /** When true, wait for the lock to become available instead of failing immediately. Defaults to false. */
    wait?: boolean;

    /** Maximum time to wait for a lock, in milliseconds. Defaults to 10000. */
    timeoutMs?: number;
}

/**
 * Character encoding. Either a string, which applies to all fields, or an object whose keys are field names and
 * whose values are encodings. If given as an object, field keys are all optional, but a 'default' key is required.
 * Valid encodings may be found here: https://github.com/ashtuchkin/iconv-lite/wiki/Supported-Encodings
 */
type Encoding = string | {default: string, [fieldName: string]: string};
```

### Testing

`npm test` runs the suite natively. `npm run test:wsl` optionally runs the full suite inside WSL
(opt-in) to exercise the POSIX `fcntl` locking path. See [TESTING.md](./TESTING.md) for details.
