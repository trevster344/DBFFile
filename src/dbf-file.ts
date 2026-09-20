import * as assert from 'assert';
import * as iconv from 'iconv-lite';
import {promises as fs} from 'fs';
import {extname} from 'path';
import {FieldDescriptor, validateFieldDescriptor} from './field-descriptor';
import {isValidFileVersion, isVfp9FileVersion} from './file-version';
import {CreateOptions, Encoding, IndexDefinition, normaliseCreateOptions, normaliseOpenOptions, OpenOptions} from './options';
import {close, open, read, stat, write} from './utils';
import {createDate, format8CharDate, formatVfpDateTime, parseVfpDateTime, parse8CharDate} from './utils';
import {FileLocker, LockError, LockOptions, LockRange} from './file-lock';
import {MemoFile} from './memo-file';
import {CDX_TYPE_COMPOUND, CdxKeyType, CdxOption, CdxTagInfo, ExpressionCompat} from './cdx/cdx-format';
import {CdxIndex} from './cdx/cdx-index';
import {encodeCdxKey, compareCdxKeys, keyPadByte} from './cdx/cdx-key';
import {CdxCollation, collationForName} from './cdx/cdx-collation';
import {CdxBuildTag, buildCdx} from './cdx/cdx-writer';
import {CdxEvalContext, CdxExpression, CdxValue} from './cdx/cdx-expression';




/** Represents a DBF file. */
export class DBFFile {

    /** Opens an existing DBF file. */
    static async open(path: string, options?: OpenOptions) {
        return openDBF(path, options);
    }

    /** Creates a new DBF file with no records. */
    static async create(path: string, fields: FieldDescriptor[], options?: CreateOptions) {
        return createDBF(path, fields, options);
    }

    /** Full path to the DBF file. */
    path = '';

    /** Total number of records in the DBF file. (NB: includes deleted records). */
    recordCount = 0;

    /** Date of last update as recorded in the DBF file header. */
    dateOfLastUpdate!: Date;

    /** Metadata for all fields defined in the DBF file. */
    fields = [] as FieldDescriptor[];

    /** Open CDX compound index, when CDX usage was opted into (empty otherwise). */
    indexes = [] as CdxIndex[];

    /** Tag metadata for the open CDX index (empty when no index is open). */
    tags = [] as CdxTagInfo[];

    /**
     * Reads a subset of records from this DBF file. If the `includeDeletedRecords` option is set, then deleted records
     * are included in the results, otherwise they are skipped. Deleted records have the property `[DELETED]: true`,
     * using the `DELETED` symbol exported from this library.
     */
    readRecords(maxCountOrOptions: number | ReadRecordsOptions = 10000000) {
        if (typeof maxCountOrOptions === 'object' && maxCountOrOptions !== null) {
            return readRecordsFromIndex(this, maxCountOrOptions);
        }
        return readRecordsFromDBF(this, maxCountOrOptions);
    }

    /** Seeks the first record matching `value` in the named CDX tag, or undefined if none matches. */
    seek(tagName: string, value: unknown): Promise<Record<string, unknown> | undefined> {
        return seekInIndex(this, tagName, value);
    }

    /** Appends the specified records to this DBF file. */
    appendRecords(records: any[]) {
        return appendRecordsToDBF(this, records);
    }

    /** Marks a record as deleted (sets the `0x2A` flag). */
    deleteRecord(index: number): Promise<DBFFile> {
        return setRecordDeleted(this, index, true);
    }

    /** Clears the deleted flag on a record. */
    undeleteRecord(index: number): Promise<DBFFile> {
        return setRecordDeleted(this, index, false);
    }

    /**
     * Updates a single record in place, at the given zero-based record index. Only the affected record
     * bytes (and any newly written memo data) are written; the rest of the file is left untouched.
     */
    updateRecord(index: number, record: Record<string, unknown>) {
        return updateRecordsInDBF(this, [{index, record}]);
    }

    /**
     * Updates multiple records in place. Each update identifies a zero-based record index and the new
     * record value. Only the affected records are written.
     */
    updateRecords(updates: Array<{index: number, record: Record<string, unknown>}>) {
        return updateRecordsInDBF(this, updates);
    }

    /**
     * Places an exclusive lock on this DBF file (its header region, at the xBase lock offset). While
     * held, other processes following the xBase locking protocol cannot lock records or the file, and
     * lock-aware reads by other instances are refused.
     */
    lockFile(options?: LockOptions): Promise<void> {
        return this._getLocker().lock(fileLockRange(this), 'write', options);
    }

    /** Releases the file lock placed by `lockFile`. */
    unlockFile(): Promise<void> {
        return this._getLocker().unlock(fileLockRange(this));
    }

    /** Places an exclusive lock on a single record's byte range. */
    lockRecord(index: number, options?: LockOptions): Promise<void> {
        assertValidRecordIndex(this, index);
        return this._getLocker().lock(recordLockRange(this, index), 'write', options);
    }

    /** Releases the record lock placed by `lockRecord`. */
    unlockRecord(index: number): Promise<void> {
        assertValidRecordIndex(this, index);
        return this._getLocker().unlock(recordLockRange(this, index));
    }

    /** Freshly probes the OS lock table to determine whether this file is locked by anyone. */
    async isFileLocked(): Promise<boolean> {
        return (await this._getLocker().probe(fileLockRange(this))).locked;
    }

    /** Freshly probes the OS lock table to determine whether the given record is locked by anyone. */
    async isRecordLocked(index: number): Promise<boolean> {
        assertValidRecordIndex(this, index);
        return (await this._getLocker().probe(recordLockRange(this, index))).locked;
    }

    /** Places an exclusive lock on the memo file's header region. No-op if this file has no memo file. */
    lockMemoFile(options?: LockOptions): Promise<void> {
        return this._getMemoLocker().lock(memoLockRange(this), 'write', options);
    }

    /** Releases the memo file lock placed by `lockMemoFile`. No-op if this file has no memo file. */
    unlockMemoFile(): Promise<void> {
        return this._getMemoLocker().unlock(memoLockRange(this));
    }

    /** Places an exclusive lock on the CDX index file's header region. */
    lockIndexFile(options?: LockOptions): Promise<void> {
        return this._getCdxLocker().lock(indexLockRange(this), 'write', options);
    }

    /** Releases the CDX index file lock placed by `lockIndexFile`. */
    unlockIndexFile(): Promise<void> {
        return this._getCdxLocker().unlock(indexLockRange(this));
    }

    /** Releases any native lock handles held by this instance, rebuilding a stale index first. */
    async close(): Promise<void> {
        if (this._indexDirty && (this._indexDefinitions || this._cdx)) {
            await this.reindex();
        }
        if (this._locker) await this._locker.close();
        if (this._memoLocker) await this._memoLocker.close();
        if (this._cdxLocker) await this._cdxLocker.close();
        this.closeIndex();
    }

    /** Opens (or re-opens) a CDX compound index and loads its tag metadata. */
    async openIndex(path?: string): Promise<CdxIndex> {
        const cdxPath = path ?? this._cdx?.path ?? cdxPathFor(this.path);
        const cdx = await withIndexReadLock(this, cdxPath, () => CdxIndex.open(cdxPath));
        this._cdx = cdx;
        this.indexes = [cdx];
        this.tags = cdx.tags;
        return cdx;
    }

    /** Closes the currently-open CDX index, if any. */
    closeIndex(): void {
        this._cdx = undefined;
        this.indexes = [];
        this.tags = [];
    }

    /**
     * Rebuilds the production CDX index (or a single tag) from the current DBF records. This is the
     * repair/reindex path used after writes and to recover stale indexes.
     *
     * By default this refuses to overwrite a tag whose rebuilt keys do not match any existing key
     * (which indicates the index was built with different expression semantics, e.g. by Sequiter
     * CodeBase). Pass `{force: true}` to reindex anyway.
     */
    reindex(tagName?: string, options?: {force?: boolean}): Promise<void> {
        return reindexDBF(this, tagName, options?.force ?? false);
    }

    // Internal: lazily-created lockers (one per file) that keep native handles alive while locks are held.
    _getLocker(): FileLocker {
        if (!this._locker) this._locker = new FileLocker(this.path);
        return this._locker;
    }

    _getMemoLocker(): FileLocker {
        if (!this._memoPath) throw new LockError('This DBF file has no memo file to lock', 'ENOMEMO');
        if (!this._memoLocker) this._memoLocker = new FileLocker(this._memoPath);
        return this._memoLocker;
    }

    _getCdxLocker(cdxPath?: string): FileLocker {
        const resolved = cdxPath ?? this._cdx?.path ?? cdxPathFor(this.path);
        if (!this._cdxLocker) this._cdxLocker = new FileLocker(resolved);
        return this._cdxLocker;
    }

    /**
     * Iterates over each record in this DBF file. If the `includeDeletedRecords` option is set, then deleted records
     * are yielded, otherwise they are skipped. Deleted records have the property `[DELETED]: true`, using the `DELETED`
     * symbol exported from this library.
     */
     async *[Symbol.asyncIterator]() {
        while (this._recordsRead !== this.recordCount) {
            yield* await this.readRecords(100);
        }
    }

    // Private.
    _readMode = 'strict' as 'strict' | 'loose';
    _encoding = '' as Encoding;
    _includeDeletedRecords = false;
    _rawCharacterFields = false;
    _locking = false;
    _lockOffset?: number;
    _expressionCompat: ExpressionCompat = 'standard';
    _readWaitTimeout = 0;
    _indexReadWaitTimeout = 10000;
    _memoBlockSize = 512;
    _recordsRead = 0;
    _headerLength = 0;
    _recordLength = 0;
    _memoPath? = '';
    _version? = 0;
    _locker?: FileLocker;
    _memoLocker?: FileLocker;
    _cdxLocker?: FileLocker;
    _cdx?: CdxIndex;
    _indexDefinitions?: IndexDefinition[];
    _indexDirty = false;
    _indexMarker?: string;
}




/** Symbol used for detecting deleted records when the `includeDeletedRecords` option is used. */
export const DELETED = Symbol();




/** Options for reading records in CDX index order. */
export interface ReadRecordsOptions {

    /** The tag name to read records in the order of. */
    index: string;

    /** Maximum number of records to return. Defaults to 10000000. */
    maxCount?: number;
}




//-------------------- Private implementation starts here --------------------
async function openDBF(path: string, opts?: OpenOptions): Promise<DBFFile> {
    let options = normaliseOpenOptions(opts);
    let fd = 0;
    try {
        // Open the file and create a buffer to read through.
        fd = await open(path, 'r');
        let buffer = Buffer.alloc(32);

        // Read various properties from the header record.
        await read(fd, buffer, 0, 32, 0);
        let fileVersion = buffer.readUInt8(0);
        let lastUpdateY = buffer.readUInt8(1); // number of years after 1900
        let lastUpdateM = buffer.readUInt8(2); // 1-based
        let lastUpdateD = buffer.readUInt8(3); // 1-based
        const dateOfLastUpdate = createDate(lastUpdateY + 1900, lastUpdateM, lastUpdateD);
        let recordCount = buffer.readInt32LE(4);
        let headerLength = buffer.readUInt16LE(8);
        let recordLength = buffer.readUInt16LE(10);
        let memoPath: string | undefined;

        // Validate the file version. Skip validation if reading in 'loose' mode.
        if (options.readMode !== 'loose' && !isValidFileVersion(fileVersion)) {
            throw new Error(`File '${path}' has unknown/unsupported dBase version: ${fileVersion}.`);
        }

        // Locate the memo file, if any. dBASE versions require one; FoxPro/VFP versions may or may not
        // have one. Allow missing memo files if reading in 'loose' mode.
        if (fileVersion === 0x83 || fileVersion === 0x8b || isVfp9FileVersion(fileVersion) || fileVersion === 0xf5) {
            const base = memoPathFor(path, fileVersion);
            const baseExt = extname(base);
            for (const candidate of [base, base.slice(0, -baseExt.length) + baseExt.toUpperCase()]) {
                memoPath = candidate;
                let foundMemoFile = await stat(candidate).catch(() => 'missing') !== 'missing';
                if (foundMemoFile) break;
                memoPath = undefined;
            }
            if ((fileVersion === 0x83 || fileVersion === 0x8b) && options.readMode !== 'loose' && !memoPath) {
                throw new Error(`Memo file not found for file '${path}'.`);
            }
        }

        // Parse all field descriptors. They are validated further below, once the record layout is resolved.
        let fields: FieldDescriptor[] = [];
        const encoding = getEncoding(options.encoding);
        while (headerLength > 32 + fields.length * 32) {
            await read(fd, buffer, 0, 32, 32 + fields.length * 32);
            if (buffer.readUInt8(0) === 0x0D) break;
            let field: FieldDescriptor = {
                name: iconv.decode(buffer.slice(0, 10), encoding).split('\0')[0],
                type: String.fromCharCode(buffer[0x0B]) as FieldDescriptor['type'],
                size: buffer.readUInt8(0x10),
                decimalPlaces: buffer.readUInt8(0x11)
            };
            fields.push(field);
        }

        // Clipper stores character field lengths longer than 255 bytes as an unsigned 16-bit value split across
        // descriptor bytes 16 and 17, using the decimal count as the high byte. But other writers leave a non-zero
        // decimal count on character fields to mean something else entirely, so the 16-bit interpretation is only
        // adopted when the standard interpretation does NOT reconcile with the record length declared in the header
        // and the 16-bit interpretation does. That keeps every file that reads correctly today reading identically:
        // such files reconcile under the standard interpretation by definition, so the branch below is not taken.
        let computedRecordLength = calculateRecordLengthInBytes(fields);
        let hasLongCharacterFields = false;
        if (recordLength !== computedRecordLength) {
            const longFields = fields.map(f => f.type === 'C' && f.decimalPlaces
                ? {...f, size: f.size + f.decimalPlaces * 256, decimalPlaces: 0}
                : f);
            const longRecordLength = calculateRecordLengthInBytes(longFields);
            if (recordLength === longRecordLength) {
                fields = longFields;
                computedRecordLength = longRecordLength;
                hasLongCharacterFields = true;
            }
        }

        // Validate all resolved field descriptors. Skip validation if reading in 'loose' mode.
        if (options.readMode !== 'loose') {
            let seenFieldNames = new Set<string>();
            for (let field of fields) {
                validateFieldDescriptor(field, fileVersion, hasLongCharacterFields ? 0xffff : 0xff);
                assert(!seenFieldNames.has(field.name), `Duplicate field name: '${field.name}'`);
                seenFieldNames.add(field.name);
            }
        }

        // Parse the header terminator.
        await read(fd, buffer, 0, 1, 32 + fields.length * 32);
        assert(buffer[0] === 0x0d, 'Invalid DBF: Expected header terminator');

        // Validate the record length.
        if (options.readMode === 'loose') recordLength = computedRecordLength;
        assert(recordLength === computedRecordLength, 'Invalid DBF: Incorrect record length');

        // Return a new DBFFile instance.
        let result = new DBFFile();
        result.path = path;
        result.recordCount = recordCount;
        result.dateOfLastUpdate = dateOfLastUpdate;
        result.fields = fields;
        result._readMode = options.readMode;
        result._encoding = options.encoding;
        result._includeDeletedRecords = options.includeDeletedRecords;
        result._locking = options.locking;
        result._lockOffset = options.lockOffset;
        result._expressionCompat = options.expressionCompat;
        result._readWaitTimeout = options.readWaitTimeout;
        result._indexReadWaitTimeout = options.indexReadWaitTimeout;
        result._recordsRead = 0;
        result._headerLength = headerLength;
        result._recordLength = recordLength;
        result._memoPath = memoPath;
        result._version = fileVersion;

        // Opt-in CDX support: open and verify the production index.
        if (options.cdx) await openCdxForResult(result, path, fileVersion, options.cdx);

        return result;
    }
    finally {
        // Close the file.
        if (fd) await close(fd);
    }
};




async function createDBF(path: string, fields: FieldDescriptor[], opts?: CreateOptions): Promise<DBFFile> {
    let options = normaliseCreateOptions(opts);
    let fd = 0;
    try {
        // Validate the field metadata.
        let fileVersion = options.fileVersion;
        validateFieldDescriptors(fields, fileVersion);

        // Memo fields are only meaningful with a memo-capable file version.
        let hasMemoFields = fields.some(f => f.type === 'M');
        if (hasMemoFields && fileVersion !== 0x83 && fileVersion !== 0x8b && !isVfp9FileVersion(fileVersion) && fileVersion !== 0xf5) {
            throw new Error(`Memo fields require file version 0x83, 0x8b, 0x30, 0x31 or 0xf5.`);
        }
        if (hasMemoFields && fileVersion === 0x83 && options.memoBlockSize !== 512) {
            throw new Error(`Version 0x83 memo files use a fixed 512-byte block size.`);
        }

        // CDX indexes require a FoxPro/VFP-compatible version (or an explicit cdx option).
        let hasIndexes = !!(options.indexes && options.indexes.length);
        if (hasIndexes) {
            const cdxVersion = options.cdx ?? (isVfp9FileVersion(fileVersion) ? 0x30 : fileVersion === 0xf5 ? 0xf5 : undefined);
            if (cdxVersion === undefined) throw new Error(`Creating CDX indexes requires a VFP/FoxPro file version or an explicit 'cdx' option.`);
        }
        const indexedFields = new Set<string>();
        if (options.indexes) for (const def of options.indexes) {
            const expression = CdxExpression.parse(def.expression);
            if (expression.referencedFields.length === 1) indexedFields.add(expression.referencedFields[0].toLowerCase());
        }

        // Create the file and create a buffer to write through.
        fd = await open(path, 'wx');
        let buffer = Buffer.alloc(32);

        // Write the header structure up to the field descriptors.
        buffer.writeUInt8(fileVersion, 0x00);                       // Version
        let now = new Date();                                       // date of last update (YYMMDD, UTC)
        buffer.writeUInt8(now.getUTCFullYear() - 1900, 0x01);       // YY (year minus 1900)
        buffer.writeUInt8(now.getUTCMonth()/* 0-based */ + 1, 0x02);// MM (1-based)
        buffer.writeUInt8(now.getUTCDate()/* 1-based */, 0x03);     // DD (1-based)
        buffer.writeInt32LE(0, 0x04);                               // Number of records (set to zero)
        let headerLength = 34 + (fields.length * 32);
        buffer.writeUInt16LE(headerLength, 0x08);                   // Length of header structure
        let recordLength = calculateRecordLengthInBytes(fields);
        buffer.writeUInt16LE(recordLength, 0x0A);                   // Length of each record
        buffer.writeUInt32LE(0, 0x0C);                              // Reserved/unused (set to zero)
        buffer.writeUInt32LE(0, 0x10);                              // Reserved/unused (set to zero)
        buffer.writeUInt32LE(0, 0x14);                              // Reserved/unused (set to zero)
        buffer.writeUInt32LE(0, 0x18);                              // Reserved/unused (set to zero)
        let tableFlags = (isVfp9FileVersion(fileVersion) || fileVersion === 0xf5) && hasMemoFields ? 0x02 : 0;
        if (hasIndexes) tableFlags |= 0x01; // structural (production) CDX present
        buffer.writeUInt32LE(tableFlags, 0x1C);                     // VFP table flags (0x02 = has memo field)
        await write(fd, buffer, 0, 32, 0);

        // Write the field descriptors.
        const encoding = getEncoding(options.encoding);
        for (let i = 0; i < fields.length; ++i) {
            let {name, type, size, decimalPlaces} = fields[i];
            const l = iconv.encode(name, encoding).copy(buffer, 0); // Field name (up to 10 bytes)
            for (let j = l; j < 11; ++j) buffer.writeUInt8(0, j);   // Field name null terminator(s)
            buffer.writeUInt8(type.charCodeAt(0), 0x0B);            // Field type
            buffer.writeUInt32LE(0, 0x0C);                          // Field data address (set to zero)
            buffer.writeUInt8(size, 0x10);                          // Field length
            buffer.writeUInt8(decimalPlaces || 0, 0x11);            // Decimal count
            buffer.writeUInt16LE(0, 0x12);                          // Reserved (set to zero)
            buffer.writeUInt8(0x01, 0x14);                          // Work area ID (always 01h for dBase III)
            buffer.writeUInt16LE(0, 0x15);                          // Reserved (set to zero)
            buffer.writeUInt8(0, 0x17);                             // Flag for SET fields (set to zero)
            buffer.writeUInt32LE(0, 0x18);                          // Reserved (set to zero)
            buffer.writeUInt32LE(0, 0x1C);                          // Reserved (set to zero)
            buffer.writeUInt8(indexedFields.has(name.toLowerCase()) ? 1 : 0, 0x1F); // Index field flag
            await write(fd, buffer, 0, 32, 32 + i * 32);
        }

        // Write the header terminator and EOF marker.
        buffer.writeUInt8(0x0D, 0);                             // Header terminator
        buffer.writeUInt8(0x00, 1);                             // Null byte (unnecessary but common, accounted for in header length)
        buffer.writeUInt8(0x1A, 2);                             // EOF marker
        await write(fd, buffer, 0, 3, 32 + fields.length * 32);

        // Create the accompanying memo file, if the file has memo fields.
        let memoPath: string | undefined;
        if (hasMemoFields) {
            memoPath = memoPathFor(path, fileVersion);
            const memo = await MemoFile.create(memoPath, fileVersion, options.memoBlockSize);
            await memo.close();
        }

        // Create the production CDX index, if indexes were requested.
        let cdxPath: string | undefined;
        if (hasIndexes) {
            cdxPath = cdxPathFor(path);
            const cdxBuffer = buildCdx(options.indexes!.map(def => emptyBuildTag(def, fields)));
            await writeIndexFile(cdxPath, cdxBuffer);
        }

        // Return a new DBFFile instance.
        let result = new DBFFile();
        result.path = path;
        result.recordCount = 0;
        result.dateOfLastUpdate = createDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
        result.fields = fields.map(field => ({...field})); // make new copy of field descriptors
        result._readMode = 'strict';
        result._encoding = options.encoding;
        result._locking = options.locking;
        result._lockOffset = options.lockOffset;
        result._expressionCompat = options.expressionCompat;
        result._readWaitTimeout = options.readWaitTimeout;
        result._indexReadWaitTimeout = options.indexReadWaitTimeout;
        result._memoBlockSize = options.memoBlockSize;
        result._recordsRead = 0;
        result._headerLength = headerLength;
        result._recordLength = recordLength;
        result._memoPath = memoPath;
        result._version = fileVersion;
        result._indexDefinitions = options.indexes;
        if (cdxPath) await result.openIndex(cdxPath);
        return result;
    }
    finally {
        // Close the file.
        if (fd) await close(fd);
    }
};




// Private implementation of DBFFile#readRecords
async function readRecordsFromDBF(dbf: DBFFile, maxCount: number) {
    let fd = 0;
    let memoFd = 0;
    let readLock: {locker: FileLocker, range: LockRange} | undefined;
    try {
        // Lock-aware reads: take a shared file lock for the duration of the read. This succeeds while
        // other readers (or a reindex, which also holds it shared) are active, but fails if a writer
        // holds the exclusive lock — so reads are refused only when a lock would actually block them.
        // Record locks do not block reads (the historical xBase "read-through" behaviour).
        if (dbf._locking) {
            const locker = dbf._getLocker();
            const range = fileLockRange(dbf);
            if (!locker.holdsRange(range)) {
                const wait = dbf._readWaitTimeout > 0;
                try {
                    await locker.lock(range, 'read', wait ? {wait: true, timeoutMs: dbf._readWaitTimeout} : undefined);
                }
                catch (err) {
                    if (err instanceof LockError && err.code === 'EBUSY') {
                        throw new LockError(`Cannot read '${dbf.path}': it is locked for writing by another process`, 'EBUSY');
                    }
                    throw err;
                }
                readLock = {locker, range};
            }
        }

        // Open the file and prepare to create a buffer to read through. Records are read in chunks of up to 1000,
        // but never more than the caller asked for, and never more than `maxBufferBytes` at a time. A record can be
        // up to 65535 bytes long, so a fixed 1000-record buffer would be up to 62MB for a file that may itself be
        // tiny. Smaller chunks don't measurably slow reading, since per-record parsing dominates.
        fd = await open(dbf.path, 'r');
        const maxBufferBytes = 1024 * 1024;
        let recordLength = dbf._recordLength;
        let recordCountPerBuffer = Math.min(
            1000,
            Math.max(1, maxCount),
            Math.max(1, Math.floor(maxBufferBytes / recordLength)),
        );
        let buffer = Buffer.alloc(recordLength * recordCountPerBuffer);

        // If there is a memo file, open it and get the block size. Also get the total file size for overflow checking.
        // The code below assumes the block size is at offset 4 in the .dbt for dBase IV files, and defaults to 512 if
        // all zeros. For dBase III files, the block size is always 512 bytes. For FoxPro the block size is at offset 6.
        // VFP9 memos can have a block size of 1, a special case where each block is sized to fit its value.
        let memoBlockSize = 0;
        let memoFileSize = 0;
        let memoBuf: Buffer | undefined;
        if (dbf._memoPath) {
            memoFd = await open(dbf._memoPath, 'r');
            if (isVfp9FileVersion(dbf._version!) || dbf._version === 0xf5) {
                // VFP9 or FoxPro 2
                await read(memoFd, buffer, 0, 2, 6);
                memoBlockSize = buffer.readUInt16BE(0) || 512;
            }
            else {
                // dBASE
                await read(memoFd, buffer, 0, 4, 4);
                memoBlockSize = (dbf._version === 0x8b ? buffer.readInt32LE(0) : 0) || 512;
            }
            memoBuf = Buffer.alloc(memoBlockSize);
            memoFileSize = (await stat(dbf._memoPath)).size;
        }

        // Calculate the file position at which to start reading.
        let currentPosition = dbf._headerLength + recordLength * dbf._recordsRead;

        // Create convenience functions for extracting values from the buffer.
        let substrAt = (start: number, len: number, enc: string) => iconv.decode(buffer.slice(start, start + len), enc);
        let int32At = (start: number, len: number) => buffer.slice(start, start + len).readInt32LE(0);

        // Read records in chunks, until enough records have been read.
        let records: Array<Record<string, unknown> & {[DELETED]?: true}> = [];
        while (true) {

            // Work out how many records to read in this chunk.
            let maxRecords1 = dbf.recordCount - dbf._recordsRead;
            let maxRecords2 = maxCount - records.length;
            let recordCountToRead = maxRecords1 < maxRecords2 ? maxRecords1 : maxRecords2;
            if (recordCountToRead > recordCountPerBuffer) recordCountToRead = recordCountPerBuffer;

            // Quit when there are no more records to read.
            if (recordCountToRead === 0) break;

            // Read the chunk of records into the buffer.
            await read(fd, buffer, 0, recordLength * recordCountToRead, currentPosition);
            dbf._recordsRead += recordCountToRead;
            currentPosition += recordLength * recordCountToRead;

            // Parse each record.
            for (let i = 0, offset = 0; i < recordCountToRead; ++i) {
                let record: Record<string, unknown> & {[DELETED]?: true} = {};
                let isDeleted = (buffer[offset++] === 0x2a);
                if (isDeleted && !dbf._includeDeletedRecords) {
                    offset += recordLength - 1;
                    continue;
                }

                // Parse each field.
                for (let j = 0; j < dbf.fields.length; ++j) {
                    let field = dbf.fields[j];
                    let len = field.size;
                    let value: any = null;
                    let encoding = getEncoding(dbf._encoding, field);

                    // Decode the field from the buffer, according to its type.
                    switch (field.type) {
                        case 'C': // Text
                            // Key building needs the untrimmed, fixed-width field value (FoxPro
                            // concatenates padded fields), so trimming is skipped in raw mode.
                            if (!dbf._rawCharacterFields) {
                                while (len > 0 && buffer[offset + len - 1] === 0x20) --len;
                            }
                            value = substrAt(offset, len, encoding);
                            offset += field.size;
                            break;

                        case 'N': // Number
                        case 'F': // Float - appears to be treated identically to Number
                            while (len > 0 && buffer[offset] === 0x20) ++offset, --len;
                            value = len > 0 ? parseFloat(substrAt(offset, len, encoding)) : null;
                            offset += len;
                            break;
                        
                        case 'Y': // Currency
                            // NB: Some precision may be lost here, since JS can't represent all 64 bit ints accurately
                            value = buffer.readBigInt64LE(offset);
                            value = Number(value) / 10_000;
                            offset += field.size;
                            break;

                        case 'L': // Boolean
                            let c = String.fromCharCode(buffer[offset++]);
                            value = 'TtYy'.indexOf(c) >= 0 ? true : ('FfNn'.indexOf(c) >= 0 ? false : null);
                            break;

                        case 'T': // DateTime
                            if (buffer[offset] === 0x20) {
                                value = null;
                            }
                            else {
                                const julianDay = buffer.readInt32LE(offset);
                                const msSinceMidnight = buffer.readInt32LE(offset + 4) + 1;
                                value = parseVfpDateTime({julianDay, msSinceMidnight});
                            }
                            offset += 8;
                            break;

                        case 'D': // Date
                            value = buffer[offset] === 0x20 ? null : parse8CharDate(substrAt(offset, 8, encoding));
                            offset += 8;
                            break;

                        case 'B': // Double
                            value = buffer.readDoubleLE(offset);
                            offset += field.size;
                            break;

                        case 'I': // Integer
                            value = buffer.readInt32LE(offset);
                            offset += field.size;
                            break;

                        case 'M': // Memo
                            let blockIndex = isVfp9FileVersion(dbf._version!)
                                ? int32At(offset, len)
                                : parseInt(substrAt(offset, len, encoding));
                            offset += len;
                            if(isNaN(blockIndex) || blockIndex === 0) {
                                value = null;
                                break;
                            }

                            // If the memo file is missing and we get this far, we must be in 'loose' read mode.
                            // Skip reading the memo value and continue with the next field.
                            if (!memoBuf) continue;

                            // Start with an empty memo value, and concatenate to it until the memo value is fully read.
                            value = '';
                            let mergedBuffer = Buffer.from([]);

                            // Read the memo data from the memo file. We use a while loop here to read one block-sized
                            // chunk at a time, since memo values can be larger than the block size.
                            while (true) {
                                if (memoBlockSize > 1) {
                                    // Read the next block-sized chunk from the memo file.
                                    await read(memoFd, memoBuf, 0, memoBlockSize, blockIndex * memoBlockSize);
                                }
                                else {
                                    // VFP9 with block size 1. This means the block size is variable to fit each value.
                                    // Read the memo length from the block header.
                                    memoBuf = memoBuf.length >= 4 ? memoBuf : Buffer.alloc(4);
                                    await read(memoFd, memoBuf, 0, 4, blockIndex + 4);
                                    len = memoBuf.readInt32BE(0);

                                    // read the entire memo value (without the header).
                                    memoBuf = Buffer.alloc(len);
                                    await read(memoFd, memoBuf, 0, len, blockIndex + 8);
                                }

                                // Handle first/next block of dBase III memo data.
                                if (dbf._version === 0x83) {
                                    // dBase III memos don't have a length header, rather they are terminated with two
                                    // 0x1A bytes. However when FoxPro is used to modify a dBase III file, it writes
                                    // only a single 0x1A byte to mark the end of a memo. Some files therefore have both
                                    // markers (ie 0x1A1A and 0x1A) present in the same file for different records. This
                                    // reader therefore only looks for a single 0x1A byte to mark the end of the memo,
                                    // so that it picks up both dBase III and FoxPro variations. (Previously this code
                                    // only checked for 0x1A1A in 0x83 files, and read past the end of the memo file
                                    // for some user-submitted test files because it missed single 0x1A markers).
                                    // If the terminator is not found in the current block-sized buffer, then the memo
                                    // value must be larger than a single block size. In that case, we continue the loop
                                    // and read the next block-sized chunk, and so on until the terminator is found.
                                    let eos = memoBuf.indexOf('\x1A');
                                    mergedBuffer = Buffer.concat([mergedBuffer, memoBuf.slice(0, eos === -1 ? memoBlockSize : eos)]);
                                    if (eos !== -1) {
                                        value = iconv.decode(mergedBuffer, encoding);
                                        break; // break out of the loop once we've found the terminator.
                                    }
                                }

                                // Handle first/next block of dBase IV memo data.
                                else if (dbf._version === 0x8b) {
                                    // dBase IV memos start with FF-FF-08-00, then a four-byte memo length, which
                                    // includes the eight-byte memo 'header' in the length. The memo length can be
                                    // larger than a block, so we loop over blocks until done.

                                    // If this is the first block of the memo, then read the field length.
                                    // Otherwise, we must have already read the length in a previous loop iteration.
                                    let isFirstBlockOfMemo = memoBuf.readInt32LE(0) === 0x0008FFFF;
                                    if (isFirstBlockOfMemo) len = memoBuf.readUInt32LE(4) - 8;

                                    // Read the chunk of memo data, and break out of the loop when all read.
                                    let skip = isFirstBlockOfMemo ? 8 : 0;
                                    let take = Math.min(len, memoBlockSize - skip);
                                    mergedBuffer = Buffer.concat([mergedBuffer, memoBuf.slice(skip, skip + take)]);
                                    len -= take;
                                    if (len === 0) {
                                        value = iconv.decode(mergedBuffer, encoding);
                                        break;
                                    }
                                }

                                // Handle first/next block of VFP9 or FoxPro 2 memo data.
                                else if (isVfp9FileVersion(dbf._version!) || dbf._version === 0xf5) {
                                    // Memo header
                                    // 00 - 03: Next free block
                                    // 04 - 05: Not used
                                    // 06 - 07: Block size
                                    // 08 - 511: Not used

                                    // Memo Block
                                    // 00 - 03: Type: 0 = image, 1 = text
                                    // 04 - 07: Length
                                    // 08 - N : Data

                                    let skip = 0;
                                    if (memoBlockSize == 1) {
                                        // For VFP9 with block size 1, the entire memo value is in memoBuf.
                                        value = iconv.decode(memoBuf, encoding);
                                        break;
                                    }

                                    if (!mergedBuffer.length) {
                                        const memoType = memoBuf.readInt32BE(0);
                                        if (memoType != 1) break;
                                        len = memoBuf.readInt32BE(4);
                                        skip = 8;
                                    }

                                    // Read the chunk of memo data, and break out of the loop when all read.
                                    let take = Math.min(len, memoBlockSize - skip);
                                    mergedBuffer = Buffer.concat([mergedBuffer, memoBuf.slice(skip, skip + take)]);
                                    len -= take;
                                    if (len === 0) {
                                        value = iconv.decode(mergedBuffer, encoding);
                                        break;
                                    }
                                }
                                else {
                                    throw new Error(`Reading version ${dbf._version} memo fields is not supported.`);
                                }
                                ++blockIndex;
                                if (blockIndex * memoBlockSize > memoFileSize) {
                                    throw new Error(`Error reading memo file (read past end).`);
                                }
                            }
                            break;

                        default:
                            // Throw an error if reading in 'strict' mode
                            if (dbf._readMode === 'strict') throw new Error(`Type '${field.type}' is not supported`);

                            // Skip over the field data if reading in 'loose' mode
                            if (dbf._readMode === 'loose') {
                                offset += field.size;
                                continue;
                            }
                    }
                    record[field.name] = value;
                }

                // If the record is marked as deleted, add the `[DELETED]` flag.
                if (isDeleted) record[DELETED] = true;

                // Add the record to the result.
                records.push(record);
            }
        }

        // Return all the records that were read.
        return records;
    }
    finally {
        // Close the file(s) and release the shared read lock.
        if (fd) await close(fd);
        if (memoFd) await close(memoFd);
        if (readLock) await readLock.locker.unlock(readLock.range);
    }
};




// Private implementation of DBFFile#readRecords when reading in CDX tag order.
async function readRecordsFromIndex(dbf: DBFFile, options: ReadRecordsOptions): Promise<Array<Record<string, unknown>>> {
    await markIndexStaleIfChanged(dbf);
    if (dbf._indexDirty) await reindexDBF(dbf);
    const cdx = dbf._cdx;
    if (!cdx) throw new Error(`No CDX index is open for '${dbf.path}'.`);
    const tag = cdx.findTag(options.index);
    if (!tag) throw new Error(`CDX tag '${options.index}' not found in '${dbf.path}'.`);
    const maxCount = options.maxCount ?? 10000000;

    return await withIndexReadLock(dbf, cdx.path, async () => {
        // Read every record once (including deleted ones) so that the array index maps to record number.
        const savedIncludeDeleted = dbf._includeDeletedRecords;
        dbf._includeDeletedRecords = true;
        dbf._recordsRead = 0;
        let all: Array<Record<string, unknown> & {[DELETED]?: true}>;
        try {
            all = await readRecordsFromDBF(dbf, Number.MAX_SAFE_INTEGER);
        }
        finally {
            dbf._includeDeletedRecords = savedIncludeDeleted;
        }

        const records: Array<Record<string, unknown>> = [];
        for (const entry of cdx.iterateTag(tag.name)) {
            // CDX record numbers are 1-based; the DBF record array is 0-based.
            const record = all[entry.recno - 1];
            if (!record) continue;
            if (record[DELETED] && !dbf._includeDeletedRecords) continue;
            records.push(record);
        }
        if (tag.descending) records.reverse();
        return records.slice(0, maxCount);
    });
}




// Private implementation of DBFFile#seek: encodes the value and locates the matching index entry.
async function seekInIndex(dbf: DBFFile, tagName: string, value: unknown): Promise<Record<string, unknown> | undefined> {
    await markIndexStaleIfChanged(dbf);
    if (dbf._indexDirty) await reindexDBF(dbf);
    const cdx = dbf._cdx;
    if (!cdx) throw new Error(`No CDX index is open for '${dbf.path}'.`);
    const tag = cdx.findTag(tagName);
    if (!tag) throw new Error(`CDX tag '${tagName}' not found in '${dbf.path}'.`);
    const search = encodeCdxKey(value, tag.keyType, tag.keyLength, collationForName(tag.collation), getEncoding(dbf._encoding));

    return await withIndexReadLock(dbf, cdx.path, async () => {
        const entry = cdx.seekTag(tag.name, search);
        if (!entry) return undefined;

        const savedIncludeDeleted = dbf._includeDeletedRecords;
        dbf._includeDeletedRecords = true;
        dbf._recordsRead = 0;
        let all: Array<Record<string, unknown> & {[DELETED]?: true}>;
        try {
            all = await readRecordsFromDBF(dbf, Number.MAX_SAFE_INTEGER);
        }
        finally {
            dbf._includeDeletedRecords = savedIncludeDeleted;
        }
        const record = all[entry.recno - 1];
        if (!record || (record[DELETED] && !dbf._includeDeletedRecords)) return undefined;
        return record;
    });
}




// Private implementation of DBFFile#appendRecords
async function appendRecordsToDBF(dbf: DBFFile, records: Array<Record<string, unknown>>): Promise<DBFFile> {
    let fd = 0;
    let memoFile: MemoFile | undefined;
    try {
        const hasMemo = dbf.fields.some(f => f.type === 'M');
        if (hasMemo && !dbf._memoPath) throw new Error(`Writing to files with memo fields requires a memo file.`);

        // Lock-aware writes: refuse unless this instance holds the file lock, with no foreign lock conflicts.
        if (dbf._locking) await assertCanWriteFile(dbf);

        // Open the file and the memo file (if any).
        fd = await open(dbf.path, 'r+');
        let recordLength = calculateRecordLengthInBytes(dbf.fields);
        if (hasMemo) memoFile = await MemoFile.open(dbf._memoPath!, dbf._version!);

        // Refresh the record count from the header, so that concurrent appenders (serialized by the file
        // lock) each start from the current end of file rather than a stale in-memory count.
        const countBuffer = Buffer.alloc(4);
        await read(fd, countBuffer, 0, 4, 0x04);
        dbf.recordCount = countBuffer.readInt32LE(0);

        // Calculate the file position at which to start appending.
        let currentPosition = dbf._headerLength + dbf.recordCount * recordLength;

        // Write the records, serializing memo writes against other processes when locking is enabled.
        await withMemoLock(dbf, async () => {
            for (let i = 0; i < records.length; ++i) {
                let record = records[i];
                validateRecord(dbf.fields, record);
                let buffer = await encodeRecord(dbf, record, memoFile);
                await write(fd, buffer, 0, recordLength, currentPosition);
                currentPosition += recordLength;
            }
        });

        // Write a new EOF marker.
        const eof = Buffer.from([0x1A]);
        await write(fd, eof, 0, 1, currentPosition);

        // Update the record count in the file and in the DBFFile instance.
        dbf.recordCount += records.length;
        countBuffer.writeInt32LE(dbf.recordCount, 0);
        await write(fd, countBuffer, 0, 4, 0x04);

        // Update the date of last update.
        await writeDateOfLastUpdate(fd);

        // Mark the index stale; it is rebuilt lazily (on close or the next index read).
        if (dbf._cdx || dbf._indexDefinitions) dbf._indexDirty = true;

        // Return the same DBFFile instance.
        return dbf;
    }
    finally {
        // Close the file(s).
        if (memoFile) await memoFile.close();
        if (fd) await close(fd);
    }
};




// Private implementation of DBFFile#updateRecords
async function updateRecordsInDBF(dbf: DBFFile, updates: Array<{index: number, record: Record<string, unknown>}>): Promise<DBFFile> {
    let fd = 0;
    let memoFile: MemoFile | undefined;
    try {
        const hasMemo = dbf.fields.some(f => f.type === 'M');
        if (hasMemo && !dbf._memoPath) throw new Error(`Writing to files with memo fields requires a memo file.`);

        // Validate all record indices up front, before anything is written.
        for (const update of updates) assertValidRecordIndex(dbf, update.index);

        // Lock-aware writes: each target record must be locked by this instance, with no foreign conflicts.
        if (dbf._locking) await assertCanWriteRecords(dbf, updates.map(u => u.index));

        fd = await open(dbf.path, 'r+');
        const recordLength = dbf._recordLength;
        if (hasMemo) memoFile = await MemoFile.open(dbf._memoPath!, dbf._version!);

        await withMemoLock(dbf, async () => {
            for (const update of updates) {
                validateRecord(dbf.fields, update.record);
                const position = dbf._headerLength + update.index * recordLength;

                // Read the existing record so its deleted flag and memo block references can be reused.
                const existing = Buffer.alloc(recordLength);
                await read(fd, existing, 0, recordLength, position);

                const buffer = await encodeRecord(dbf, update.record, memoFile, existing);
                await write(fd, buffer, 0, recordLength, position);
            }
        });

        // Update the date of last update.
        await writeDateOfLastUpdate(fd);
        if (dbf._cdx || dbf._indexDefinitions) dbf._indexDirty = true;
        return dbf;
    }
    finally {
        // Close the file(s).
        if (memoFile) await memoFile.close();
        if (fd) await close(fd);
    }
};




// Private implementation of DBFFile#deleteRecord / #undeleteRecord.
async function setRecordDeleted(dbf: DBFFile, index: number, deleted: boolean): Promise<DBFFile> {
    assertValidRecordIndex(dbf, index);
    if (dbf._locking) await assertCanWriteRecords(dbf, [index]);
    const fd = await open(dbf.path, 'r+');
    try {
        const position = dbf._headerLength + index * dbf._recordLength;
        await write(fd, Buffer.from([deleted ? 0x2a : 0x20]), 0, 1, position);
        await writeDateOfLastUpdate(fd);
    }
    finally {
        await close(fd);
    }
    if (dbf._cdx || dbf._indexDefinitions) dbf._indexDirty = true;
    return dbf;
}




// Encodes a single record into a buffer. When `existing` is given (in-place update), the deleted flag
// and existing memo block references are preserved/reused; otherwise a new, active record is encoded.
async function encodeRecord(
    dbf: DBFFile,
    record: Record<string, unknown>,
    memoFile?: MemoFile,
    existing?: Buffer
): Promise<Buffer> {
    let recordLength = calculateRecordLengthInBytes(dbf.fields);
    let buffer = Buffer.alloc(recordLength);
    let offset = 0;
    buffer.writeUInt8(existing ? existing[0] : 0x20, offset++); // Record deleted flag

    for (let j = 0; j < dbf.fields.length; ++j) {

        // Get the field's value.
        let field = dbf.fields[j];
        let value: any = record[field.name];
        if (value === null || typeof value === 'undefined') value = '';
        let encoding = getEncoding(dbf._encoding, field);

        // Encode the field in the buffer, according to its type.
        switch (field.type) {

            case 'C': // Text
                let b = iconv.encode(value, encoding);
                for (let k = 0; k < field.size; ++k) {
                    let byte = k < b.length ? b[k] : 0x20;
                    buffer.writeUInt8(byte, offset++);
                }
                break;

            case 'N': // Number
            case 'F': // Float - appears to be treated identically to Number
                value = value.toString();
                value = value.slice(0, field.size);
                while (value.length < field.size) value = ' ' + value;
                iconv.encode(value, encoding).copy(buffer, offset, 0, field.size);
                offset += field.size;
                break;

            case 'Y': // Currency
                // NB: Some precision may be lost here, since JS can't represent all 64 bit ints accurately
                value = Math.round(value * 10_000);
                buffer.writeBigInt64LE(BigInt(value), offset);
                offset += field.size;
                break;

            case 'L': // Boolean
                buffer.writeUInt8(value === '' ? 0x20 : value ? 0x54/* 'T' */ : 0x46/* 'F' */, offset++);
                break;

            case 'T': // DateTime
                if (!value) {
                    iconv.encode('        ', encoding).copy(buffer, offset, 0, 8);
                }
                else {
                    const {julianDay, msSinceMidnight} = formatVfpDateTime(value);
                    buffer.writeInt32LE(julianDay, offset);
                    buffer.writeInt32LE(msSinceMidnight, offset + 4);
                }
                offset += 8;
                break;

            case 'D': // Date
                value = value ? format8CharDate(value) : '        ';
                iconv.encode(value, encoding).copy(buffer, offset, 0, 8);
                offset += 8;
                break;

            case 'B': // Double
                buffer.writeDoubleLE(value, offset);
                offset += field.size;
                break;

            case 'I': // Integer
                buffer.writeInt32LE(value, offset);
                offset += field.size;
                break;

            case 'M': // Memo
                if (!memoFile) throw new Error(`Writing to files with memo fields requires a memo file.`);
                let reuseBlockIndex = existing ? decodeMemoBlockIndex(dbf, field, existing, offset) : 0;
                let blockIndex = await memoFile.writeMemo(typeof value === 'string' ? value : String(value), encoding, reuseBlockIndex);
                encodeMemoBlockIndex(dbf, field, buffer, offset, blockIndex, encoding);
                offset += field.size;
                break;

            default:
                throw new Error(`Type '${field.type}' is not supported`);
        }
    }
    return buffer;
};




// Decodes the memo block index already stored in a record buffer (used to reuse an existing memo chain).
function decodeMemoBlockIndex(dbf: DBFFile, field: FieldDescriptor, buffer: Buffer, offset: number): number {
    if (isVfp9FileVersion(dbf._version!)) return buffer.readInt32LE(offset);
    const text = iconv.decode(buffer.slice(offset, offset + field.size), 'ascii').trim();
    const blockIndex = parseInt(text, 10);
    return isNaN(blockIndex) ? 0 : blockIndex;
}




// Encodes a memo block index into a record buffer, in the format appropriate to the file version.
function encodeMemoBlockIndex(dbf: DBFFile, field: FieldDescriptor, buffer: Buffer, offset: number, blockIndex: number, encoding: string): void {
    if (isVfp9FileVersion(dbf._version!)) {
        buffer.writeInt32LE(blockIndex, offset);
        return;
    }
    const text = (blockIndex ? String(blockIndex) : '').padStart(field.size, ' ');
    iconv.encode(text, encoding).copy(buffer, offset, 0, field.size);
}




// Throws unless the given zero-based record index is within the file's record count.
function assertValidRecordIndex(dbf: DBFFile, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= dbf.recordCount) {
        throw new Error(`Record index ${index} is out of range (0..${dbf.recordCount - 1})`);
    }
}




// Lock-aware guard for whole-file writes (appends): the caller must hold the file lock, with no foreign lock.
async function assertCanWriteFile(dbf: DBFFile): Promise<void> {
    const locker = dbf._getLocker();
    const range = fileLockRange(dbf);
    if (locker.holdsRange(range)) return;
    const probe = await locker.probe(range);
    if (probe.locked) throw new LockError(`Cannot write '${dbf.path}': it is locked by another process`, 'EBUSY');
    throw new LockError(`Cannot write '${dbf.path}': call lockFile() before writing when locking is enabled`, 'ENOLOCK');
}




// Lock-aware guard for in-place record writes: each target record must be locked by this instance.
async function assertCanWriteRecords(dbf: DBFFile, indices: number[]): Promise<void> {
    const locker = dbf._getLocker();
    const fileRange = fileLockRange(dbf);
    // A foreign *exclusive* lock (an appender) blocks record writes; a shared lock (a concurrent read
    // or reindex) does not, since the record bytes are a different range.
    if (!locker.holdsRange(fileRange) && await hasForeignExclusiveLock(locker, fileRange)) {
        throw new LockError(`Cannot write '${dbf.path}': the file is locked for writing by another process`, 'EBUSY');
    }
    for (const index of indices) {
        const range = recordLockRange(dbf, index);
        if (locker.holdsRange(range)) continue;
        const probe = await locker.probe(range);
        if (probe.locked) throw new LockError(`Cannot write record ${index} in '${dbf.path}': it is locked by another process`, 'EBUSY');
        throw new LockError(`Cannot write record ${index} in '${dbf.path}': call lockRecord(${index}) before writing when locking is enabled`, 'ENOLOCK');
    }
}




// Probes whether an exclusive lock is held on a range by another process/handle: a shared lock is
// attempted (and released), which fails only when an exclusive lock is present.
async function hasForeignExclusiveLock(locker: FileLocker, range: LockRange): Promise<boolean> {
    try {
        await locker.lock(range, 'read');
    }
    catch (err) {
        if (err instanceof LockError && err.code === 'EBUSY') return true;
        throw err;
    }
    await locker.unlock(range);
    return false;
}




// Serializes memo writes against other processes by holding the memo file header lock, when locking is enabled.
async function withMemoLock<T>(dbf: DBFFile, action: () => Promise<T>): Promise<T> {
    if (!dbf._locking || !dbf._memoPath) return action();
    const locker = dbf._getMemoLocker();
    const range = memoLockRange(dbf);
    const alreadyHeld = locker.holdsRange(range);
    if (!alreadyHeld) await locker.lock(range, 'write');
    try {
        return await action();
    }
    finally {
        if (!alreadyHeld) await locker.unlock(range);
    }
}




// Writes the current date into the DBF header's date-of-last-update field (bytes 1-3).
async function writeDateOfLastUpdate(fd: number): Promise<void> {
    const now = new Date();
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(now.getUTCFullYear() - 1900, 0);
    buffer.writeUInt8(now.getUTCMonth() + 1, 1);
    buffer.writeUInt8(now.getUTCDate(), 2);
    await write(fd, buffer, 0, 3, 1);
}




// Computes the accompanying memo file path for a DBF path and file version.
//
// Conventions for memo extensions: .dbf => .fpt | .pjx => .pjt | .scx => .sct | .vcx => .vct | .frx => .frt ...
// dBASE versions always use .dbt. If the computed path would equal the DBF path itself (for a DBF whose
// extension has no memo mapping, e.g. 'table.out'), the memo extension is appended instead, so that the
// memo file can never overwrite the DBF file.
function memoPathFor(path: string, version: number): string {
    const dbExt = extname(path).toLowerCase();
    const stem = path.slice(0, -extname(path).length);
    let memoExt: string;
    if (version === 0x83 || version === 0x8b) {
        memoExt = '.dbt';
    }
    else if (dbExt !== '.dbf' && /^\.[a-z]{2}x$/.test(dbExt)) {
        memoExt = `.${dbExt.substr(1, 2)}t`;
    }
    else {
        memoExt = '.fpt';
    }
    const candidate = stem + memoExt;
    return candidate === path ? path + memoExt : candidate;
}




// Computes the production CDX path (same base name as the DBF, .cdx extension).
function cdxPathFor(dbfPath: string): string {
    return dbfPath.slice(0, -extname(dbfPath).length) + '.cdx';
}




// Opens and verifies the production CDX index for a DBF opened with the `cdx` option.
async function openCdxForResult(result: DBFFile, dbfPath: string, fileVersion: number, cdxOption: CdxOption): Promise<void> {
    const cdxVersion = typeof cdxOption === 'object' ? cdxOption.version : cdxOption;
    // A Visual FoxPro CDX requires a VFP9 table (0x30/0x31). A FoxPro 2.x CDX pairs with a 0xf5 table
    // (with memo) or a 0x03 table (no memo) — the latter shares its version byte with dBase III+, so
    // the presence of the `.cdx` is what distinguishes it.
    const dbfMatches = cdxVersion === 0x30
        ? isVfp9FileVersion(fileVersion)
        : (fileVersion === 0xf5 || fileVersion === 0x03);
    if (!dbfMatches) {
        throw new Error(`CDX compatibility 0x${cdxVersion.toString(16)} does not match DBF version 0x${fileVersion.toString(16)} for '${dbfPath}'.`);
    }
    let cdxPath: string;
    if (typeof cdxOption === 'object' && cdxOption.path) {
        cdxPath = cdxOption.path;
    }
    else {
        cdxPath = cdxPathFor(dbfPath);
        if (await stat(cdxPath).catch(() => 'missing') === 'missing') {
            const upper = cdxPath.slice(0, -4) + '.CDX';
            if (await stat(upper).catch(() => 'missing') !== 'missing') cdxPath = upper;
        }
    }
    if (await stat(cdxPath).catch(() => 'missing') === 'missing') {
        throw new Error(`CDX index not found for '${dbfPath}': expected '${cdxPath}'.`);
    }
    const cdx = await withIndexReadLock(result, cdxPath, () => CdxIndex.open(cdxPath));
    if ((cdx.header.options & CDX_TYPE_COMPOUND) === 0) {
        throw new Error(`'${cdxPath}' is not a compound CDX index.`);
    }
    // Infer each tag's key type: from a simple field-name expression, else from the expression's
    // static result type (e.g. `val(...)` -> numeric), so key decoding and padding are correct.
    for (const tag of cdx.tags) {
        const field = result.fields.find(f => f.name.toLowerCase() === tag.keyExpression.toLowerCase());
        if (field) {
            tag.keyType = fieldTypeToKeyType(field.type);
            continue;
        }
        try {
            const expression = CdxExpression.parse(tag.keyExpression, {compat: result._expressionCompat});
            tag.keyType = expression.inferKeyType(name => {
                const referenced = result.fields.find(f => f.name.toLowerCase() === name.toLowerCase());
                return referenced ? fieldTypeToKeyType(referenced.type) : undefined;
            });
        }
        catch {
            tag.keyType = 'C';
        }
    }
    result._cdx = cdx;
    result.indexes = [cdx];
    result.tags = cdx.tags;
    result._indexMarker = indexMarkerFor(result);
}




function fieldTypeToKeyType(type: FieldDescriptor['type']): CdxKeyType {
    switch (type) {
        case 'N': case 'F': case 'I': case 'Y': case 'B': return 'N';
        case 'D': return 'D';
        case 'T': return 'T';
        case 'L': return 'L';
        default: return 'C';
    }
}




// The index key length for a simple field expression, matching FoxPro's fixed-width key encodings.
// Character fields depend on the collation: MACHINE uses one byte per character, other sequences
// (e.g. GENERAL) use two.
function fieldKeyLength(field: FieldDescriptor, collation: CdxCollation): number {
    switch (field.type) {
        case 'I': return 4;
        case 'N': case 'F': case 'Y': case 'B': case 'D': case 'T': return 8;
        case 'L': return 1;
        default: return collation.keyLengthFor(field.size);
    }
}




function simpleFieldFor(expression: CdxExpression, fields: FieldDescriptor[]): FieldDescriptor | undefined {
    if (expression.referencedFields.length !== 1) return undefined;
    const name = expression.referencedFields[0].toLowerCase();
    return fields.find(field => field.name.toLowerCase() === name);
}




// Builds an empty tag (no keys) for a newly created index.
function emptyBuildTag(def: IndexDefinition, fields: FieldDescriptor[]): CdxBuildTag {
    const expression = CdxExpression.parse(def.expression);
    const field = simpleFieldFor(expression, fields);
    const collation = collationForName(def.collation);
    return {
        name: def.tag,
        keyExpression: def.expression,
        forExpression: def.for,
        keyLength: field ? fieldKeyLength(field, collation) : 240,
        keyType: field ? fieldTypeToKeyType(field.type) : 'C',
        descending: !!def.descending,
        unique: !!def.unique,
        collation: def.collation,
        keys: [],
    };
}




function makeEvalContext(record: Record<string, unknown> & {[DELETED]?: true}): CdxEvalContext {
    return {
        getField: name => {
            const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
            const value = key ? record[key] : undefined;
            return value === undefined || value === null ? null : value as CdxValue;
        },
        isDeleted: () => record[DELETED] === true,
    };
}




function truthyValue(value: CdxValue): boolean {
    if (value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (value instanceof Date) return !isNaN(value.getTime());
    return value.length > 0;
}




// Builds a tag's sorted key list from the current records, applying the key and FOR expressions.
function buildTagFromRecords(dbf: DBFFile, def: IndexDefinition, records: Array<Record<string, unknown> & {[DELETED]?: true}>, compat = dbf._expressionCompat): CdxBuildTag {
    const expression = CdxExpression.parse(def.expression, {compat});
    const forExpression = def.for ? CdxExpression.parse(def.for, {compat}) : undefined;
    const field = simpleFieldFor(expression, dbf.fields);
    const collation = collationForName(def.collation);

    // Determine the key type from the expression's result type, and the key length from a simple
    // field (preserving the field width, as CodeBase/VFP do) when the types agree, else from samples.
    const inferred = expression.inferKeyType(name => {
        const referenced = dbf.fields.find(f => f.name.toLowerCase() === name.toLowerCase());
        return referenced ? fieldTypeToKeyType(referenced.type) : undefined;
    });
    let keyType: CdxKeyType;
    let keyLength: number;
    if (field && fieldTypeToKeyType(field.type) === inferred) {
        keyType = inferred;
        keyLength = fieldKeyLength(field, collation);
    }
    else {
        keyType = inferred;
        keyLength = keyType === 'C' ? collation.keyLengthFor(maxTextLength(expression, records)) : keyType === 'L' ? 1 : 8;
    }

    const keys: Array<{key: Buffer, recno: number}> = [];
    for (let i = 0; i < records.length; ++i) {
        const record = records[i];
        if (record[DELETED]) continue;
        const context = makeEvalContext(record);
        if (forExpression && !truthyValue(forExpression.evaluate(context))) continue;
        const value = expression.evaluate(context);
        keys.push({key: encodeCdxKey(value, keyType, keyLength, collation, getEncoding(dbf._encoding)), recno: i + 1});
    }
    const pad = keyPadByte(keyType);
    keys.sort((a, b) => compareCdxKeys(a.key, b.key, pad) || a.recno - b.recno);
    const finalKeys = def.unique ? dedupeKeys(keys, pad) : keys;
    return {
        name: def.tag,
        keyExpression: def.expression,
        forExpression: def.for,
        keyLength,
        keyType,
        descending: !!def.descending,
        unique: !!def.unique,
        collation: def.collation,
        keys: finalKeys,
    };
}




// Keeps only the first key of each equal-key run (unique index behaviour).
function dedupeKeys(keys: Array<{key: Buffer, recno: number}>, pad: number): Array<{key: Buffer, recno: number}> {
    const result: Array<{key: Buffer, recno: number}> = [];
    let previous: Buffer | undefined;
    for (const entry of keys) {
        if (previous && compareCdxKeys(previous, entry.key, pad) === 0) continue;
        result.push(entry);
        previous = entry.key;
    }
    return result;
}




// Counts how many rebuilt keys equal the stored key for the same record (logically, ignoring pad).
function countKeyMatches(stored: Map<number, Buffer>, keys: Array<{key: Buffer, recno: number}>, pad: number): number {
    let matches = 0;
    for (const entry of keys) {
        const previous = stored.get(entry.recno);
        if (previous && compareCdxKeys(previous, entry.key, pad) === 0) ++matches;
    }
    return matches;
}




// Safety net before overwriting an existing tag. If the rebuilt keys match none of the stored keys,
// the mismatch is either (a) the index was built with different expression semantics (e.g. by
// Sequiter CodeBase, whose RIGHT() behaves like LEFT()), or (b) every record was legitimately
// changed. These are distinguished by rebuilding under the *other* compatibility mode: if that
// reproduces the stored keys, the index belongs to the other mode, so refuse rather than clobber it.
function assertTagReproducible(dbf: DBFFile, def: IndexDefinition, buildTag: CdxBuildTag, records: Array<Record<string, unknown> & {[DELETED]?: true}>): void {
    const cdx = dbf._cdx;
    if (!cdx) return;
    const existingTag = cdx.findTag(buildTag.name);
    if (!existingTag) return;
    let stored: Map<number, Buffer>;
    try {
        stored = new Map([...cdx.iterateTag(existingTag.name)].map(entry => [entry.recno, entry.key]));
    }
    catch {
        return;
    }
    if (!stored.size) return;
    if (countKeyMatches(stored, buildTag.keys, keyPadByte(buildTag.keyType)) > 0) return;

    const alternative = dbf._expressionCompat === 'codebase' ? 'standard' : 'codebase';
    let alternativeTag: CdxBuildTag;
    try {
        alternativeTag = buildTagFromRecords(dbf, def, records, alternative);
    }
    catch {
        return;
    }
    if (countKeyMatches(stored, alternativeTag.keys, keyPadByte(alternativeTag.keyType)) > 0) {
        throw new Error(
            `Refusing to reindex tag '${buildTag.name}' in '${dbf.path}': the rebuilt keys match none of the ` +
            `${stored.size} existing key(s), but they are reproduced under the '${alternative}' expression semantics. ` +
            `Re-open with { expressionCompat: '${alternative}' }, or pass { force: true } to reindex anyway.`);
    }
}




function maxTextLength(expression: CdxExpression, records: Array<Record<string, unknown> & {[DELETED]?: true}>): number {
    let max = 1;
    for (const record of records) {
        if (record[DELETED]) continue;
        const value = expression.evaluate(makeEvalContext(record));
        const length = value === null ? 0 : String(value).length;
        if (length > max) max = length;
    }
    return Math.min(max, 240);
}




// Rebuilds the production CDX (or one tag) from the DBF's current records.
// Refreshes the cached DBF header fields from disk, so that reindexing and staleness checks observe
// changes made by other processes (appends, edits, deletes).
async function refreshDbfHeader(dbf: DBFFile): Promise<void> {
    const fd = await open(dbf.path, 'r');
    try {
        const buffer = Buffer.alloc(32);
        await read(fd, buffer, 0, 32, 0);
        dbf.recordCount = buffer.readInt32LE(4);
        dbf.dateOfLastUpdate = createDate(buffer.readUInt8(1) + 1900, buffer.readUInt8(2), buffer.readUInt8(3));
        dbf._headerLength = buffer.readUInt16LE(8);
        dbf._recordLength = buffer.readUInt16LE(10);
    }
    finally {
        await close(fd);
    }
}




// A fingerprint of the DBF header used to detect on-disk changes since the index was last built.
function indexMarkerFor(dbf: DBFFile): string {
    return `${dbf.recordCount}:${dbf.dateOfLastUpdate.getTime()}:${dbf._headerLength}:${dbf._recordLength}`;
}




// Marks the index stale when the DBF header on disk differs from the last indexed marker, so that
// changes made by another process (or another instance) are picked up before an index read/seek.
async function markIndexStaleIfChanged(dbf: DBFFile): Promise<void> {
    if (dbf._indexDirty) return;
    if (!dbf._cdx && !dbf._indexDefinitions) return;
    await refreshDbfHeader(dbf);
    if (dbf._indexMarker !== undefined && dbf._indexMarker !== indexMarkerFor(dbf)) {
        dbf._indexDirty = true;
    }
}




// Reads every record (including deleted) with character fields left padded to their field width, for
// index key computation (FoxPro concatenates padded fields, so trimming must not happen here).
async function readRecordsForIndex(dbf: DBFFile): Promise<Array<Record<string, unknown> & {[DELETED]?: true}>> {
    const savedRaw = dbf._rawCharacterFields;
    const savedIncludeDeleted = dbf._includeDeletedRecords;
    dbf._rawCharacterFields = true;
    dbf._includeDeletedRecords = true;
    dbf._recordsRead = 0;
    try {
        return await readRecordsFromDBF(dbf, Number.MAX_SAFE_INTEGER);
    }
    finally {
        dbf._rawCharacterFields = savedRaw;
        dbf._includeDeletedRecords = savedIncludeDeleted;
    }
}




// Private implementation of DBFFile#reindex
async function reindexDBF(dbf: DBFFile, tagName?: string, force = false): Promise<void> {
    const definitions: IndexDefinition[] = dbf._indexDefinitions ?? dbf._cdx?.tags.map(tag => ({
        tag: tag.name,
        expression: tag.keyExpression,
        for: tag.forExpression,
        descending: tag.descending,
        unique: tag.unique,
        collation: tag.collation,
    })) ?? [];
    if (!definitions || !definitions.length) throw new Error(`No CDX index definitions to reindex for '${dbf.path}'.`);
    const selected = tagName ? definitions.filter(def => def.tag.toLowerCase() === tagName.toLowerCase()) : definitions;
    if (!selected.length) throw new Error(`CDX tag '${tagName}' not found in '${dbf.path}'.`);

    const cdxPath = dbf._cdx?.path ?? cdxPathFor(dbf.path);

    // Hold the exclusive index lock across the whole read-rebuild-write. If it were only taken around
    // the write, a reindex that read an older DBF snapshot could still be the last to write and clobber
    // a newer index built by another process.
    const locker = dbf._locking ? dbf._getCdxLocker() : undefined;
    const range = indexLockRange(dbf);
    const alreadyHeld = locker ? locker.holdsRange(range) : false;
    if (locker && !alreadyHeld) await locker.lock(range, 'write', {wait: true, timeoutMs: 30000});
    try {
        // Read the DBF under a shared file lock, so we wait for an in-progress writer rather than
        // reading a half-appended file (and do not trip the lock-aware read guard). The header is
        // refreshed inside the lock so the record count is current.
        const fileLocker = dbf._locking ? dbf._getLocker() : undefined;
        const fileRange = fileLockRange(dbf);
        const fileAlreadyHeld = fileLocker ? fileLocker.holdsRange(fileRange) : false;
        if (fileLocker && !fileAlreadyHeld) await fileLocker.lock(fileRange, 'read', {wait: true, timeoutMs: 30000});
        let records: Array<Record<string, unknown> & {[DELETED]?: true}>;
        try {
            await refreshDbfHeader(dbf);
            records = await readRecordsForIndex(dbf);
        }
        finally {
            if (fileLocker && !fileAlreadyHeld) await fileLocker.unlock(fileRange);
        }
        const buildTags = selected.map(def => buildTagFromRecords(dbf, def, records));
        if (!force) selected.forEach((def, i) => assertTagReproducible(dbf, def, buildTags[i], records));
        await writeIndexFile(cdxPath, buildCdx(buildTags, true));
    }
    finally {
        if (locker && !alreadyHeld) await locker.unlock(range);
    }
    dbf._indexDefinitions = definitions;
    await dbf.openIndex(cdxPath);
    await setStructuralIndexFlag(dbf.path);
    dbf._indexDirty = false;
    dbf._indexMarker = indexMarkerFor(dbf);
}




// Sets the DBF header's structural (production) CDX flag (byte 0x1C, bit 0x01).
async function setStructuralIndexFlag(dbfPath: string): Promise<void> {
    const fd = await open(dbfPath, 'r+');
    try {
        const buffer = Buffer.alloc(1);
        await read(fd, buffer, 0, 1, 0x1C);
        buffer[0] |= 0x01;
        await write(fd, buffer, 0, 1, 0x1C);
    }
    finally {
        await close(fd);
    }
}




// Writes the index file. It first tries an atomic replace (temp file + rename), so non-locking
// readers never see a partial file. Windows refuses to rename over a file that another handle has
// open — which is the case whenever the index lock is held — so it falls back to an in-place write,
// which is safe for lock-aware readers because the caller holds the exclusive index lock while
// readers hold a shared lock.
async function writeIndexFile(path: string, buffer: Buffer): Promise<void> {
    const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(temp, buffer);
    try {
        await fs.rename(temp, path);
        return;
    }
    catch (err: any) {
        const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
        await fs.unlink(temp).catch(() => {});
        if (!transient) throw err;
    }
    await fs.writeFile(path, buffer);
}




// The historical xBase lock offset defaults: FoxPro/SoftC use 4 billion, Clipper/dBASE use 1 billion.
function defaultLockOffset(version: number | undefined): number {
    return isVfp9FileVersion(version ?? 0) || version === 0xf5 ? 4_000_000_000 : 1_000_000_000;
}




function lockOffsetFor(dbf: DBFFile): number {
    return dbf._lockOffset ?? defaultLockOffset(dbf._version);
}




// A whole-file lock is a lock on the header region at the lock offset.
function fileLockRange(dbf: DBFFile): LockRange {
    return {start: lockOffsetFor(dbf), length: Math.max(dbf._headerLength, 32)};
}




// A record lock covers the record's bytes, at the lock offset past the header.
function recordLockRange(dbf: DBFFile, index: number): LockRange {
    return {start: lockOffsetFor(dbf) + dbf._headerLength + index * dbf._recordLength, length: dbf._recordLength};
}




// The memo file lock covers the memo file's header region.
function memoLockRange(dbf: DBFFile): LockRange {
    return {start: lockOffsetFor(dbf), length: 512};
}




// The CDX index file lock covers the index file's header region.
function indexLockRange(dbf: DBFFile): LockRange {
    return {start: lockOffsetFor(dbf), length: 512};
}




// Runs an index read while holding a shared index lock, so it is mutually excluded with a reindex
// (which holds the exclusive lock). A no-op unless locking is enabled.
async function withIndexReadLock<T>(dbf: DBFFile, cdxPath: string, action: () => Promise<T>): Promise<T> {
    if (!dbf._locking) return action();
    const locker = dbf._getCdxLocker(cdxPath);
    const range = indexLockRange(dbf);
    const alreadyHeld = locker.holdsRange(range);
    if (!alreadyHeld) {
        const wait = dbf._indexReadWaitTimeout > 0;
        await locker.lock(range, 'read', wait ? {wait: true, timeoutMs: dbf._indexReadWaitTimeout} : undefined);
    }
    try {
        return await action();
    }
    finally {
        if (!alreadyHeld) await locker.unlock(range);
    }
}




// Private helper function
function validateFieldDescriptors(fields: FieldDescriptor[], fileVersion: number): void {
    if (fields.length > 2046) throw new Error('Too many fields (maximum is 2046)');
    for (let field of fields) validateFieldDescriptor(field, fileVersion);
}




// Private helper function
function validateRecord(fields: FieldDescriptor[], record: Record<string, unknown>): void {
    for (let i = 0; i < fields.length; ++i) {
        let name = fields[i].name, type = fields[i].type;
        let value = record[name];

        // Always allow null values
        if (value === null || typeof value === 'undefined') continue;

        // Perform type-specific checks
        if (type === 'C') {
            if (typeof value !== 'string') throw new Error(`${name}: expected a string`);
            if (value.length > 255) throw new Error(`${name}: text is too long (maximum length is 255 chars)`);
        }
        else if (type === 'N' || type === 'F' || type === 'I' || type === 'Y') {
            if (typeof value !== 'number') throw new Error(`${name}: expected a number`);
        }
        else if (type === 'D') {
            if (!(value instanceof Date)) throw new Error(`${name}: expected a date`);
        }
        else if (type === 'L') {
            if (typeof value !== 'boolean') throw new Error(`${name}: expected a boolean`);
        }
        else if (type === 'M') {
            if (typeof value !== 'string') throw new Error(`${name}: expected a string`);
        }
    }
}




// Private helper function
function calculateRecordLengthInBytes(fields: FieldDescriptor[]): number {
    let len = 1; // 'Record deleted flag' adds one byte
    for (let i = 0; i < fields.length; ++i) len += fields[i].size;
    return len;
}




// Private helper function
function getEncoding(encoding: Encoding, field?: FieldDescriptor) {
    if (typeof encoding === 'string') return encoding;
    return encoding[field?.name ?? 'default'] || encoding.default;
}
