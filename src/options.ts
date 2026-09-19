import {encodingExists} from 'iconv-lite';
import {FileVersion, isValidFileVersion} from './file-version';




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
}




/** OpenOptions with defaults applied. */
export interface NormalisedOpenOptions {
    encoding: Encoding;
    readMode: 'strict' | 'loose';
    includeDeletedRecords: boolean;
    locking: boolean;
    lockOffset?: number;
}




/** CreateOptions with defaults applied. */
export interface NormalisedCreateOptions {
    fileVersion: FileVersion;
    encoding: Encoding;
    memoBlockSize: number;
    locking: boolean;
    lockOffset?: number;
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

    // Return a new normalised options object.
    return {encoding, readMode, includeDeletedRecords, locking, lockOffset};
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

    // Return a new normalised options object.
    return {fileVersion, encoding, memoBlockSize, locking, lockOffset};
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
