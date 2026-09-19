import {encodingExists} from 'iconv-lite';
import {FileVersion, isValidFileVersion} from './file-version';
import {CdxOption, CdxVersion, ExpressionCompat} from './cdx/cdx-format';




/** Options for opening a DBF file. */
export interface OpenOptions {

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

    /** Indicates whether deleted records should be included in results when reading records. Defaults to false. */
    includeDeletedRecords?: boolean;

    /**
     * Enables lock-aware behaviour. When true, reads are refused while another process holds a
     * blocking (file) lock, and writes are refused unless this instance holds the appropriate
     * record/file lock and no foreign lock conflicts. When false (the default), the lock methods
     * are still available but no automatic checks are performed. Lock state is always probed
     * freshly from the OS; it is never cached.
     */
    locking?: boolean;

    /**
     * Overrides the synthetic xBase lock offset used to place write locks beyond the real data
     * (so that reads remain unblocked). Defaults to 4,000,000,000 for FoxPro/VFP files and
     * 1,000,000,000 for dBASE/Clipper files.
     */
    lockOffset?: number;

    /**
     * Opts in to CDX compound-index usage. The raw version states the assumed index compatibility
     * (`0x30` for Visual FoxPro 9, `0xf5` for FoxPro 2.x); an object may also carry an explicit path.
     * When set, the production `<dbf-base>.cdx` (or the given path) is opened and verified. Omit to
     * ignore any `.cdx` present. CDX is a FoxPro-family index, so only `0x30` and `0xf5` are accepted.
     * `0x30` requires a VFP9 table (`0x30`/`0x31`); `0xf5` requires a FoxPro 2.x table (`0xf5`, or
     * `0x03` for a table without a memo field — the version byte `0x03` is shared with dBase III+).
     */
    cdx?: CdxOption;

    /**
     * Expression-evaluation compatibility for index keys and FOR filters. `'standard'` (the default)
     * follows FoxPro semantics; `'codebase'` reproduces Sequiter CodeBase quirks, notably `RIGHT()`
     * evaluating as `LEFT()` for variable/subexpression arguments. Use `'codebase'` when reading and
     * reindexing `.cdx` files originally built by CodeBase.
     */
    expressionCompat?: ExpressionCompat;
}




/** Definition of a CDX tag to create. */
export interface IndexDefinition {

    /** Tag name (up to 10 characters). */
    tag: string;

    /** The key expression (e.g. `NAME`, `UPPER(NAME)`, `UPPER(CLASS)+STR(LOCATION)`). */
    expression: string;

    /** Optional FOR filter expression (e.g. `.NOT. DELETED()`). */
    for?: string;

    /** Whether the tag is a unique index. */
    unique?: boolean;

    /** Whether the tag is descending. */
    descending?: boolean;

    /** The VFP sort sequence (collation) for the tag. Defaults to `MACHINE`. */
    collation?: string;
}




/** Options for creating a DBF file. */
export interface CreateOptions {

    /** The file version to create. Currently versions 0x03, 0x83, 0x8b, 0x30 and 0xf5 are supported. Defaults to 0x03. */
    fileVersion?: FileVersion;

    /** The character encoding(s) to use when writing the DBF file. Defaults to ISO-8859-1. */
    encoding?: Encoding;

    /** The block size to use for a newly created memo file. Defaults to 512. */
    memoBlockSize?: number;

    /** Enables lock-aware behaviour on the created instance. See `OpenOptions.locking`. Defaults to false. */
    locking?: boolean;

    /**
     * Overrides the synthetic xBase lock offset used to place write locks beyond the real data.
     * Defaults to 4,000,000,000 for FoxPro/VFP files and 1,000,000,000 for dBASE/Clipper files.
     */
    lockOffset?: number;

    /**
     * Opts in to CDX compound-index usage. The raw version states the assumed index compatibility
     * (`0x30` for Visual FoxPro 9, `0xf5` for FoxPro 2.x); an object may also carry an explicit path.
     * When set, the production `<dbf-base>.cdx` (or the given path) is opened and verified. Omit to
     * ignore any `.cdx` present. CDX is a FoxPro-family index, so only `0x30` and `0xf5` are accepted.
     */
    cdx?: CdxVersion;

    /** CDX tags to create alongside the DBF. */
    indexes?: IndexDefinition[];

    /**
     * Expression-evaluation compatibility for index keys and FOR filters. `'standard'` (the default)
     * follows FoxPro semantics; `'codebase'` reproduces Sequiter CodeBase quirks, notably `RIGHT()`
     * evaluating as `LEFT()` for variable/subexpression arguments.
     */
    expressionCompat?: ExpressionCompat;
}




/** OpenOptions with defaults applied. */
export interface NormalisedOpenOptions {
    encoding: Encoding;
    readMode: 'strict' | 'loose';
    includeDeletedRecords: boolean;
    locking: boolean;
    lockOffset?: number;
    cdx?: CdxOption;
    expressionCompat: ExpressionCompat;
}




/** CreateOptions with defaults applied. */
export interface NormalisedCreateOptions {
    fileVersion: FileVersion;
    encoding: Encoding;
    memoBlockSize: number;
    locking: boolean;
    lockOffset?: number;
    cdx?: CdxVersion;
    indexes?: IndexDefinition[];
    expressionCompat: ExpressionCompat;
}




/**
 * Character encoding. Either a string, which applies to all fields, or an object whose keys are field names and
 * whose values are encodings. If given as an object, field keys are all optional, but a 'default' key is required.
 * Valid encodings may be found here: https://github.com/ashtuchkin/iconv-lite/wiki/Supported-Encodings
 */
export type Encoding = string | {default: string, [fieldName: string]: string};




/** Validates the given OpenOptions and substitutes defaults for missing properties. Returns a new options object. */
export function normaliseOpenOptions(options: OpenOptions | undefined): NormalisedOpenOptions {

    // Validate `encoding`.
    let encoding = options?.encoding ?? 'ISO-8859-1';
    assertValidEncoding(encoding);

    // Validate `readMode`.
    let readMode = options?.readMode ?? 'strict';
    if (readMode !== 'strict' && readMode !== 'loose') {
        throw new Error(`Invalid read mode ${readMode}`);
    }

    // Validate `includeDeletedRecords`.
    let includeDeletedRecords = options?.includeDeletedRecords ?? false;
    if (typeof includeDeletedRecords !== 'boolean') {
        throw new Error(`Invalid value 'includeDeletedRecords' value ${includeDeletedRecords}`);
    }

    // Validate `locking`.
    let locking = options?.locking ?? false;
    if (typeof locking !== 'boolean') {
        throw new Error(`Invalid 'locking' value ${locking}`);
    }

    // Validate `lockOffset`.
    let lockOffset = options?.lockOffset;
    if (lockOffset !== undefined && (typeof lockOffset !== 'number' || !Number.isInteger(lockOffset) || lockOffset < 0)) {
        throw new Error(`Invalid 'lockOffset' value ${lockOffset}`);
    }

    // Validate `cdx`.
    let cdx = options?.cdx;
    assertValidCdxOption(cdx);

    // Validate `expressionCompat`.
    let expressionCompat = options?.expressionCompat ?? 'standard';
    assertValidExpressionCompat(expressionCompat);

    // Return a new normalised options object.
    return {encoding, readMode, includeDeletedRecords, locking, lockOffset, cdx, expressionCompat};
}




/** Validates the given CreateOptions and substitutes defaults for missing properties. Returns a new options object. */
export function normaliseCreateOptions(options: CreateOptions | undefined): NormalisedCreateOptions {

    // Validate `fileVersion`.
    let fileVersion = options?.fileVersion ?? 0x03;
    if (!isValidFileVersion(fileVersion)) throw new Error(`Invalid file version ${fileVersion}`);

    // Validate `encoding`.
    let encoding = options?.encoding ?? 'ISO-8859-1';
    assertValidEncoding(encoding);

    // Validate `memoBlockSize`.
    let memoBlockSize = options?.memoBlockSize ?? 512;
    if (typeof memoBlockSize !== 'number' || !Number.isInteger(memoBlockSize) || memoBlockSize < 512) {
        throw new Error(`Invalid 'memoBlockSize' value ${memoBlockSize} (minimum is 512)`);
    }

    // Validate `locking`.
    let locking = options?.locking ?? false;
    if (typeof locking !== 'boolean') {
        throw new Error(`Invalid 'locking' value ${locking}`);
    }

    // Validate `lockOffset`.
    let lockOffset = options?.lockOffset;
    if (lockOffset !== undefined && (typeof lockOffset !== 'number' || !Number.isInteger(lockOffset) || lockOffset < 0)) {
        throw new Error(`Invalid 'lockOffset' value ${lockOffset}`);
    }

    // Validate `cdx`.
    let cdx = options?.cdx;
    if (cdx !== undefined && cdx !== 0x30 && cdx !== 0xf5) {
        throw new Error(`Invalid 'cdx' version ${cdx} (must be 0x30 or 0xf5)`);
    }

    // Validate `indexes`.
    let indexes = options?.indexes;
    if (indexes !== undefined) {
        if (!Array.isArray(indexes)) throw new Error(`Invalid 'indexes' value (must be an array)`);
        for (const index of indexes) {
            if (!index || typeof index.tag !== 'string' || !index.tag) throw new Error(`Invalid index definition: missing tag name`);
            if (index.tag.length > 10) throw new Error(`Index tag '${index.tag}' is too long (maximum is 10 chars)`);
            if (typeof index.expression !== 'string' || !index.expression) throw new Error(`Index tag '${index.tag}': missing key expression`);
        }
    }

    // Validate `expressionCompat`.
    let expressionCompat = options?.expressionCompat ?? 'standard';
    assertValidExpressionCompat(expressionCompat);

    // Return a new normalised options object.
    return {fileVersion, encoding, memoBlockSize, locking, lockOffset, cdx, indexes, expressionCompat};
}




// Helper function for validating encodings.
function assertValidEncoding(encoding: unknown): asserts encoding is Encoding {
    if (typeof encoding === 'string') {
        if (!encodingExists(encoding)) throw new Error(`Unsupported character encoding '${encoding}'`);
    }
    else if (typeof encoding === 'object' && encoding !== null) {
        let encodingObject = encoding as Record<string, string>;
        if (!encodingObject.default) throw new Error(`No default encoding specified`);
        for (let key of Object.keys(encodingObject)) {
            if (!encodingExists(encodingObject[key])) throw new Error(`Unsupported character encoding '${encoding}'`);
        }
    }
    else {
        throw new Error(`Invalid encoding value ${encoding}`);
    }
}




// Helper function for validating the CDX opt-in (raw version, or an object carrying a version).
function assertValidCdxOption(cdx: unknown): asserts cdx is CdxOption {
    if (cdx === undefined) return;
    const version = typeof cdx === 'object' && cdx !== null ? (cdx as {version?: unknown}).version : cdx;
    if (version !== 0x30 && version !== 0xf5) {
        throw new Error(`Invalid 'cdx' version ${String(version)} (must be 0x30 or 0xf5)`);
    }
}




// Helper function for validating the expression-compatibility mode.
function assertValidExpressionCompat(value: unknown): asserts value is ExpressionCompat {
    if (value !== 'standard' && value !== 'codebase') {
        throw new Error(`Invalid 'expressionCompat' value ${String(value)} (must be 'standard' or 'codebase')`);
    }
}
