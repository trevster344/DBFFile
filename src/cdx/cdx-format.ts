/**
 * Low-level constants and helpers for the FoxPro/Visual FoxPro CDX compound index format.
 *
 * Layouts were derived from the Harbour `dbfcdx` RDD (`hbrddcdx.h`, `dbfcdx1.c`) and verified
 * against real VFP9 `.cdx` files. A CDX is a compound index: a tag directory B-tree maps 10-byte
 * tag names to tag-header pages, and each tag header points at a per-tag compressed B-tree.
 */




/** Length of an index page, in bytes. */
export const CDX_PAGE_LEN = 512;

/** Length of a tag header, in bytes (spans two pages). */
export const CDX_HEADER_LEN = 1024;

/** Length of an interior (non-leaf) node header, in bytes. */
export const CDX_INT_HEADER_LEN = 12;

/** Length of an exterior (leaf) node header, in bytes. */
export const CDX_EXT_HEADER_LEN = 24;

/** Maximum key length, in bytes. */
export const CDX_MAX_KEY_LEN = 240;

/** Maximum tag name length, in bytes. */
export const CDX_MAX_TAG_NAME_LEN = 10;

/** Offset of the key/FOR expression pool within a tag header. */
export const CDX_EXPRESSION_POOL_OFFSET = 512;




/** Node attribute flags (first two bytes of a page). */
export const CDX_NODE_BRANCH = 0x00;
export const CDX_NODE_ROOT = 0x01;
export const CDX_NODE_LEAF = 0x02;
export const CDX_NODE_UNUSED = 0xff;




/** Tag index options (byte 14 of a tag header). */
export const CDX_TYPE_UNIQUE = 0x01;
export const CDX_TYPE_PARTIAL = 0x02;
export const CDX_TYPE_CUSTOM = 0x04;
export const CDX_TYPE_FORFILTER = 0x08;
export const CDX_TYPE_BITVECTOR = 0x10;
export const CDX_TYPE_COMPACT = 0x20;
export const CDX_TYPE_COMPOUND = 0x40;
export const CDX_TYPE_STRUCTURE = 0x80;




/** Key types, matching the DBF field types used to encode a tag's key values. */
export type CdxKeyType = 'C' | 'N' | 'D' | 'T' | 'L';




/** DBF versions that use CDX indexes (raw versions, matching FileVersion). */
export type CdxVersion = 0x30 | 0xf5;




/** CDX opt-in: either the raw index version, or an object carrying an explicit path. */
export type CdxOption = CdxVersion | {version: CdxVersion; path?: string};




/**
 * Expression-evaluation compatibility mode. `standard` follows FoxPro semantics; `codebase`
 * reproduces Sequiter CodeBase quirks — notably `RIGHT()` behaving like `LEFT()` for
 * variable-length/subexpression arguments (CodeBase aliases `RIGHT` to its `SUBSTR` routine).
 */
export type ExpressionCompat = 'standard' | 'codebase';




/** Metadata describing a single tag within a CDX file. */
export interface CdxTagInfo {

    /** Tag name (up to 10 characters). */
    name: string;

    /** The key expression, as written in the tag header (e.g. `code`, `UPPER(NAME)`). */
    keyExpression: string;

    /** The FOR expression, if the tag is filtered (VFP always adds `.NOT.DELETED()`). */
    forExpression?: string;

    /** Key length in bytes, as stored in the tag header. */
    keyLength: number;

    /** Key type, inferred from the key expression's field (defaults to `C`). */
    keyType: CdxKeyType;

    /** Raw tag index option flags. */
    options: number;

    /** Whether the tag is a unique index. */
    unique: boolean;

    /** Whether the tag is a partial (custom/partial) index. */
    partial: boolean;

    /** Whether the tag has a FOR filter expression. */
    filtered: boolean;

    /** Whether the tag is descending. */
    descending: boolean;

    /** Whether keys are upper-cased before comparison. */
    ignoreCase: boolean;

    /** The VFP sort-sequence (collation) name recorded in the tag header (e.g. `GENERAL`, `MACHINE`). */
    collation?: string;

    /** Page offset of the tag header. */
    headerPage: number;

    /** Page offset of the tag's root node. */
    rootPage: number;
}
