import {promises as fs} from 'fs';
import {
    CDX_EXPRESSION_POOL_OFFSET,
    CDX_EXT_HEADER_LEN,
    CDX_HEADER_LEN,
    CDX_INT_HEADER_LEN,
    CDX_MAX_TAG_NAME_LEN,
    CDX_NODE_LEAF,
    CDX_PAGE_LEN,
    CDX_TYPE_CUSTOM,
    CDX_TYPE_FORFILTER,
    CDX_TYPE_PARTIAL,
    CDX_TYPE_UNIQUE,
    CdxTagInfo,
} from './cdx-format';
import {compareCdxKeys} from './cdx-key';




/** Parsed CDX file header (page 0 / first 512 bytes). */
export interface CdxFileHeader {
    rootPage: number;
    freePage: number;
    version: number;
    keyLength: number;
    options: number;
    signature: number;
}




/**
 * A read-only view of a FoxPro/Visual FoxPro CDX compound index. Phase 1 parses the file header,
 * the tag directory, and each tag header, exposing tag metadata via {@link tags}.
 */
export class CdxIndex {
    readonly path: string;
    readonly header: CdxFileHeader;
    readonly tags: CdxTagInfo[];
    private data: Buffer;

    private constructor(path: string, data: Buffer, header: CdxFileHeader, tags: CdxTagInfo[]) {
        this.path = path;
        this.data = data;
        this.header = header;
        this.tags = tags;
    }

    /** Opens and parses a CDX file. */
    static async open(path: string): Promise<CdxIndex> {
        const data = await fs.readFile(path);
        if (data.length < CDX_HEADER_LEN) throw new Error(`Invalid CDX: '${path}' is too small.`);
        const header = parseFileHeader(data);
        const tags = parseTagDirectory(data, header);
        return new CdxIndex(path, data, header, tags);
    }

    /** The parsed file contents (used by later phases for node traversal). */
    get buffer(): Buffer {
        return this.data;
    }

    /** Finds a tag by name (case-insensitive). */
    findTag(name: string): CdxTagInfo | undefined {
        const lower = name.toLowerCase();
        return this.tags.find(tag => tag.name.toLowerCase() === lower);
    }

    /** Iterates a tag's leaf entries in key order, yielding decompressed keys and record numbers. */
    *iterateTag(tagName: string): IterableIterator<LeafEntry> {
        const tag = this.findTag(tagName);
        if (!tag) throw new Error(`CDX tag '${tagName}' not found.`);
        const trailingChar = tag.keyType === 'C' ? 0x20 : 0x00;
        let pageOffset = this.firstLeaf(tag);
        while (pageOffset !== -1) {
            const leaf = readLeafNode(this.data, pageOffset, tag.keyLength, trailingChar);
            for (const entry of leaf.entries) yield entry;
            pageOffset = leaf.right;
        }
    }

    // Descends to the leftmost leaf of a tag's B-tree.
    private firstLeaf(tag: CdxTagInfo): number {
        let pageOffset = tag.rootPage;
        if (!pageOffset) return -1;
        for (;;) {
            const attr = this.data.readUInt16LE(pageOffset);
            if ((attr & CDX_NODE_LEAF) !== 0) return pageOffset;
            pageOffset = readInteriorChild(this.data, pageOffset, 0, tag.keyLength);
            if (pageOffset === 0xffffffff) return -1;
        }
    }

    /** Finds the entry whose key equals the encoded `search` key, or undefined if there is none. */
    seekTag(tagName: string, search: Buffer): LeafEntry | undefined {
        const tag = this.findTag(tagName);
        if (!tag) throw new Error(`CDX tag '${tagName}' not found.`);
        if (search.length !== tag.keyLength) throw new Error(`CDX seek key must be ${tag.keyLength} bytes.`);
        const trailingChar = tag.keyType === 'C' ? 0x20 : 0x00;
        let pageOffset = tag.rootPage;
        if (!pageOffset) return undefined;
        for (;;) {
            const attr = this.data.readUInt16LE(pageOffset);
            if ((attr & CDX_NODE_LEAF) !== 0) {
                const leaf = readLeafNode(this.data, pageOffset, tag.keyLength, trailingChar);
                for (const entry of leaf.entries) {
                    const cmp = compareCdxKeys(entry.key, search, trailingChar);
                    if (cmp === 0) return entry;
                    if (cmp > 0) return undefined;
                }
                if (leaf.right === -1) return undefined;
                pageOffset = leaf.right;
                continue;
            }
            const nKeys = this.data.readUInt16LE(pageOffset + 2);
            const index = this.findInteriorIndex(pageOffset, tag.keyLength, search, nKeys, trailingChar);
            pageOffset = readInteriorChild(this.data, pageOffset, index, tag.keyLength);
            if (pageOffset === 0xffffffff) return undefined;
        }
    }

    // Binary-searches an interior node for the first key that is >= the search key.
    private findInteriorIndex(pageOffset: number, keyLength: number, search: Buffer, nKeys: number, pad: number): number {
        let l = 0, r = nKeys - 1;
        while (l < r) {
            const mid = (l + r) >> 1;
            const keyOffset = pageOffset + CDX_INT_HEADER_LEN + mid * (keyLength + 8);
            const key = this.data.slice(keyOffset, keyOffset + keyLength);
            if (compareCdxKeys(key, search, pad) < 0) l = mid + 1;
            else r = mid;
        }
        return l;
    }

    /**
     * Returns the leaf pages of a tag in key order (following the leaf links). Useful for integrity
     * checks. Throws if the leaf chain contains a cycle.
     */
    leaves(tagName: string): Array<{page: number, left: number, right: number, count: number}> {
        const tag = this.findTag(tagName);
        if (!tag) throw new Error(`CDX tag '${tagName}' not found.`);
        const trailingChar = tag.keyType === 'C' ? 0x20 : 0x00;
        const result: Array<{page: number, left: number, right: number, count: number}> = [];
        const seen = new Set<number>();
        let page = this.firstLeaf(tag);
        while (page !== -1) {
            if (seen.has(page)) throw new Error(`CDX tag '${tagName}' has a cycle in its leaf links.`);
            seen.add(page);
            const leaf = readLeafNode(this.data, page, tag.keyLength, trailingChar);
            result.push({page, left: leaf.left, right: leaf.right, count: leaf.entries.length});
            page = leaf.right;
        }
        return result;
    }
}




function parseFileHeader(data: Buffer): CdxFileHeader {
    const rootPage = data.readUInt32LE(0);
    const freePage = data.readInt32LE(4);
    const version = data.readUInt32BE(8);
    const keyLength = data.readUInt16LE(12);
    const options = data[14];
    const signature = data[15];
    if (rootPage % CDX_PAGE_LEN !== 0 || rootPage < CDX_HEADER_LEN) {
        throw new Error(`Invalid CDX: bad tag directory root page ${rootPage}.`);
    }
    return {rootPage, freePage, version, keyLength, options, signature};
}




function parseTagDirectory(data: Buffer, header: CdxFileHeader): CdxTagInfo[] {
    const entries = readLeafNode(data, header.rootPage, header.keyLength, 0x20).entries;
    return entries.map(entry => parseTagHeader(data, entry.recno, entry.key));
}




interface LeafEntry {
    key: Buffer;
    recno: number;
}




interface LeafNode {
    entries: LeafEntry[];
    left: number;
    right: number;
}




/**
 * Decodes a leaf node. Keys are compressed (duplicate-prefix and trailing-byte elimination) and
 * stored backwards from the end of the page; the bit widths of the record number, duplicate count
 * and trailing count are recorded in the node header. Leaves are linked via their left/right
 * pointers (0xFFFFFFFF means none).
 */
function readLeafNode(data: Buffer, pageOffset: number, keyLength: number, trailingChar: number): LeafNode {
    const page = data.slice(pageOffset, pageOffset + CDX_PAGE_LEN);
    const attr = page.readUInt16LE(0);
    const nKeys = page.readUInt16LE(2);
    if ((attr & CDX_NODE_LEAF) === 0) {
        throw new Error(`Invalid CDX: page ${pageOffset} is not a leaf node.`);
    }
    const left = page.readInt32LE(4);
    const right = page.readInt32LE(8);
    const recMask = page.readUInt32LE(14);
    const dupMask = page[18];
    const trlMask = page[19];
    const dupBits = page[21];
    const trlBits = page[22];
    const reqByte = page[23];

    const poolBase = CDX_EXT_HEADER_LEN;
    let keyPos = CDX_PAGE_LEN - CDX_EXT_HEADER_LEN;
    let keyLen = keyLength;
    const key = Buffer.alloc(keyLength, trailingChar);
    const entries: LeafEntry[] = [];

    for (let i = 0; i < nKeys; ++i) {
        const pos = i * reqByte;
        const packed = page.readUInt32LE(poolBase + pos + reqByte - 4) >>> (32 - trlBits - dupBits);
        const dup = i === 0 ? 0 : (packed & dupMask);
        const trl = (packed >> dupBits) & trlMask;
        const copyLen = keyLength - dup - trl;
        if (copyLen > 0) {
            keyPos -= copyLen;
            page.copy(key, dup, poolBase + keyPos, poolBase + keyPos + copyLen);
        }
        const fill = keyLen - keyLength + trl;
        if (trl > 0 && fill > 0) key.fill(trailingChar, keyLength - trl, keyLength - trl + fill);
        keyLen = keyLength - trl;
        const recno = page.readUInt32LE(poolBase + pos) & recMask;
        entries.push({key: Buffer.from(key), recno});
    }
    return {entries, left, right};
}




/**
 * Returns the child page referenced by entry `index` of an interior node. Interior entries are
 * stored uncompressed as [key(keyLength)][record number (BE)][child page (BE)].
 */
function readInteriorChild(data: Buffer, pageOffset: number, index: number, keyLength: number): number {
    const entryOffset = pageOffset + CDX_INT_HEADER_LEN + index * (keyLength + 8);
    return data.readUInt32BE(entryOffset + keyLength + 4);
}




function parseTagHeader(data: Buffer, pageOffset: number, name: Buffer): CdxTagInfo {
    const header = data.slice(pageOffset, pageOffset + CDX_HEADER_LEN);
    const rootPage = header.readUInt32LE(0);
    const keyLength = header.readUInt16LE(12);
    const options = header[14];
    const ascendFlg = header.readUInt16LE(502);
    let forExpPos = header.readUInt16LE(504);
    let forExpLen = header.readUInt16LE(506);
    let keyExpPos = header.readUInt16LE(508);
    let keyExpLen = header.readUInt16LE(510);
    const pool = header.slice(CDX_EXPRESSION_POOL_OFFSET, CDX_HEADER_LEN);

    // Some writers omit the expression lengths; derive them from the positions (Harbour does the same).
    if (keyExpPos === 0 && keyExpLen !== 0 && forExpPos === 0 && forExpLen !== 0) forExpPos = keyExpLen;
    if (!keyExpLen) keyExpLen = (forExpPos >= keyExpPos ? forExpPos : pool.length) - keyExpPos;
    if (!forExpLen) forExpLen = (forExpPos <= keyExpPos ? keyExpPos : pool.length) - forExpPos;

    const keyExpression = readCString(pool, keyExpPos, keyExpLen);
    const forExpression = forExpLen > 0 ? readCString(pool, forExpPos, forExpLen) : '';

    return {
        name: name.toString('latin1').slice(0, CDX_MAX_TAG_NAME_LEN).replace(/\0/g, '').trimEnd(),
        keyExpression,
        forExpression: forExpression || undefined,
        keyLength,
        keyType: 'C',
        options,
        unique: (options & CDX_TYPE_UNIQUE) !== 0,
        partial: (options & (CDX_TYPE_PARTIAL | CDX_TYPE_CUSTOM)) !== 0,
        filtered: (options & CDX_TYPE_FORFILTER) !== 0 || !!forExpression,
        descending: ascendFlg !== 0,
        ignoreCase: false,
        collation: readCollation(header),
        headerPage: pageOffset,
        rootPage,
    };
}




function readCString(buffer: Buffer, offset: number, length: number): string {
    if (length <= 0 || offset < 0 || offset >= buffer.length) return '';
    const slice = buffer.slice(offset, Math.min(offset + length, buffer.length));
    const end = slice.indexOf(0);
    return (end === -1 ? slice : slice.slice(0, end)).toString('latin1').trim();
}




function readCollation(header: Buffer): string | undefined {
    const raw = header.slice(494, 510);
    const end = raw.indexOf(0);
    const text = (end === -1 ? raw : raw.slice(0, end)).toString('latin1').trim();
    return /^[A-Za-z0-9_ -]+$/.test(text) && text.length > 0 ? text : undefined;
}
