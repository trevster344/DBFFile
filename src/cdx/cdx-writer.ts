import {
    CDX_EXPRESSION_POOL_OFFSET,
    CDX_EXT_HEADER_LEN,
    CDX_HEADER_LEN,
    CDX_INT_HEADER_LEN,
    CDX_NODE_BRANCH,
    CDX_NODE_LEAF,
    CDX_NODE_ROOT,
    CDX_PAGE_LEN,
    CDX_TYPE_COMPACT,
    CDX_TYPE_COMPOUND,
    CDX_TYPE_FORFILTER,
    CDX_TYPE_STRUCTURE,
    CDX_TYPE_UNIQUE,
    CdxKeyType,
} from './cdx-format';




/** A single key/record pair to be written into a tag. */
export interface CdxBuildKey {
    key: Buffer;
    recno: number;
}




/** A tag to be built into a CDX file. */
export interface CdxBuildTag {
    name: string;
    keyExpression: string;
    forExpression?: string;
    keyLength: number;
    keyType: CdxKeyType;
    descending: boolean;
    unique?: boolean;
    ignoreCase?: boolean;
    collation?: string;
    /** Keys sorted ascending by key bytes (then record number). */
    keys: CdxBuildKey[];
}




interface PageAllocator {
    pages: Buffer[];
    allocate(): number;
}




function createAllocator(): PageAllocator {
    return {
        pages: [],
        allocate(): number {
            const page = Buffer.alloc(CDX_PAGE_LEN);
            this.pages.push(page);
            return this.pages.length - 1;
        },
    };
}




function bitsForMax(maxValue: number): number {
    return maxValue <= 0 ? 1 : 32 - Math.clz32(maxValue);
}




function trailingCount(key: Buffer, trailingChar: number): number {
    let n = 0;
    while (n < key.length && key[key.length - 1 - n] === trailingChar) ++n;
    return n;
}




function commonPrefix(a: Buffer, b: Buffer, limit: number): number {
    let n = 0;
    while (n < limit && a[n] === b[n]) ++n;
    return n;
}




/**
 * Builds a tag's B-tree bottom-up and returns the root page number. Leaves are packed greedily with
 * the FoxPro key compression (duplicate-prefix and trailing-byte elimination) and linked via their
 * left/right pointers; interior levels use uncompressed keys with a child pointer per entry.
 */
function buildTree(allocator: PageAllocator, keys: CdxBuildKey[], keyLength: number, trailingChar: number): number {
    const maxRecno = keys.reduce((max, k) => Math.max(max, k.recno), 0);
    const recBits = bitsForMax(maxRecno);
    const dupBits = bitsForMax(keyLength);
    const trlBits = bitsForMax(keyLength);
    const reqByte = Math.ceil((recBits + dupBits + trlBits) / 8);
    const recMask = (1 << recBits) - 1;
    const dupMask = (1 << dupBits) - 1;
    const trlMask = (1 << trlBits) - 1;

    // Build leaf pages.
    interface Child { page: number; lastKey: Buffer; lastRec: number; }
    const children: Child[] = [];
    let index = 0;
    let prevLeafPage = -1;
    while (index < keys.length || children.length === 0) {
        const pageNumber = allocator.allocate();
        const page = allocator.pages[pageNumber];
        const entries: Array<{dup: number, trl: number, middle: Buffer, recno: number}> = [];
        let prevKey: Buffer | undefined;
        let used = CDX_EXT_HEADER_LEN;
        let lastKey = keys[index] ? keys[index].key : Buffer.alloc(keyLength, trailingChar);
        let lastRec = keys[index] ? keys[index].recno : 0;
        while (index < keys.length) {
            const {key, recno} = keys[index];
            const trl = trailingCount(key, trailingChar);
            const dup = prevKey ? commonPrefix(prevKey, key, keyLength - trl) : 0;
            const middle = key.slice(dup, keyLength - trl);
            const cost = reqByte + middle.length;
            if (entries.length > 0 && used + cost > CDX_PAGE_LEN) break;
            entries.push({dup, trl, middle, recno});
            used += cost;
            prevKey = key;
            lastKey = key;
            lastRec = recno;
            ++index;
        }

        // Write the leaf header.
        page.writeUInt16LE(CDX_NODE_LEAF, 0);
        page.writeUInt16LE(entries.length, 2);
        page.writeInt32LE(prevLeafPage === -1 ? -1 : prevLeafPage * CDX_PAGE_LEN, 4);
        page.writeInt32LE(-1, 8);
        page.writeUInt16LE(CDX_PAGE_LEN - used, 12);
        page.writeUInt32LE(recMask, 14);
        page[18] = dupMask;
        page[19] = trlMask;
        page[20] = recBits;
        page[21] = dupBits;
        page[22] = trlBits;
        page[23] = reqByte;

        // Write entries and compressed key data (backwards from the end of the page).
        let keyPos = CDX_PAGE_LEN;
        for (let i = 0; i < entries.length; ++i) {
            const entry = entries[i];
            const offset = CDX_EXT_HEADER_LEN + i * reqByte;
            const shift = reqByte * 8 - dupBits - trlBits;
            const meta = (entry.dup & dupMask) | ((entry.trl & trlMask) << dupBits);
            const packed = (entry.recno & recMask) | (meta << shift);
            for (let b = 0; b < reqByte; ++b) page[offset + b] = (packed >>> (b * 8)) & 0xff;
            keyPos -= entry.middle.length;
            entry.middle.copy(page, keyPos);
        }

        if (prevLeafPage !== -1) allocator.pages[prevLeafPage].writeInt32LE(pageNumber * CDX_PAGE_LEN, 8);
        prevLeafPage = pageNumber;
        children.push({page: pageNumber, lastKey, lastRec});
        if (index >= keys.length) break;
    }

    // Build interior levels until a single root remains.
    let level: Child[] = children;
    while (level.length > 1) {
        const maxKeys = Math.max(1, Math.floor((CDX_PAGE_LEN - CDX_INT_HEADER_LEN) / (keyLength + 8)));
        const next: Child[] = [];
        let i = 0;
        while (i < level.length) {
            const pageNumber = allocator.allocate();
            const page = allocator.pages[pageNumber];
            const group = level.slice(i, i + maxKeys);
            page.writeUInt16LE(CDX_NODE_BRANCH, 0);
            page.writeUInt16LE(group.length, 2);
            page.writeInt32LE(-1, 4);
            page.writeInt32LE(-1, 8);
            for (let j = 0; j < group.length; ++j) {
                const entryOffset = CDX_INT_HEADER_LEN + j * (keyLength + 8);
                group[j].lastKey.copy(page, entryOffset);
                page.writeUInt32BE(group[j].lastRec, entryOffset + keyLength);
                page.writeUInt32BE(group[j].page * CDX_PAGE_LEN, entryOffset + keyLength + 4);
            }
            next.push({page: pageNumber, lastKey: group[group.length - 1].lastKey, lastRec: group[group.length - 1].lastRec});
            i += maxKeys;
        }
        level = next;
    }

    const root = level[0];
    // Mark the root page: set the ROOT flag while preserving its branch/leaf flag.
    const existing = allocator.pages[root.page].readUInt16LE(0);
    allocator.pages[root.page].writeUInt16LE(CDX_NODE_ROOT | (existing & CDX_NODE_LEAF), 0);
    return root.page * CDX_PAGE_LEN;
}




/**
 * Builds a complete CDX compound index file in memory from the given tags. The tag directory maps
 * 10-byte tag names to tag-header page offsets; each tag header points at its own B-tree.
 */
export function buildCdx(tags: CdxBuildTag[], production = true): Buffer {
    const allocator = createAllocator();
    // Reserve the two file-header pages.
    allocator.allocate();
    allocator.allocate();
    // Reserve the tag directory root page (page 2), filled in after tag headers are placed.
    const directoryPage = allocator.allocate();

    const directoryEntries: Array<{name: Buffer, headerPage: number}> = [];

    for (const tag of tags) {
        const headerPage = allocator.allocate();
        allocator.allocate(); // tag headers span two pages
        const trailingChar = tag.keyType === 'C' ? 0x20 : 0x00;
        const rootPage = buildTree(allocator, tag.keys, tag.keyLength, trailingChar);

        const header = Buffer.alloc(CDX_HEADER_LEN);
        header.writeUInt32LE(rootPage, 0);
        header.writeUInt32LE(0, 4);
        header.writeUInt32LE(0, 8);
        header.writeUInt16LE(tag.keyLength, 12);
        let options = CDX_TYPE_COMPOUND | CDX_TYPE_COMPACT;
        if (tag.forExpression) options |= CDX_TYPE_FORFILTER;
        if (tag.unique) options |= CDX_TYPE_UNIQUE;
        header[14] = options;
        header[15] = 0x01;
        if (tag.collation) header.write(tag.collation, 494, 'latin1');
        header.writeUInt16LE(tag.descending ? 1 : 0, 502);
        const pool = header.slice(CDX_EXPRESSION_POOL_OFFSET);
        const keyBytes = Buffer.from(tag.keyExpression, 'latin1');
        keyBytes.copy(pool, 0);
        let forPos = keyBytes.length + 1;
        let forLen = 0;
        if (tag.forExpression) {
            const forBytes = Buffer.from(tag.forExpression, 'latin1');
            forBytes.copy(pool, forPos);
            forLen = forBytes.length + 1;
        }
        header.writeUInt16LE(0, 508);                 // keyExpPos
        header.writeUInt16LE(keyBytes.length + 1, 510); // keyExpLen
        header.writeUInt16LE(forPos, 504);            // forExpPos
        header.writeUInt16LE(forLen, 506);            // forExpLen
        header.copy(allocator.pages[headerPage]);
        header.copy(allocator.pages[headerPage + 1], 0, CDX_PAGE_LEN);

        directoryEntries.push({name: Buffer.from(tag.name, 'latin1'), headerPage});
    }

    // Write the tag directory leaf (tag name -> tag header page).
    const directory = allocator.pages[directoryPage];
    directory.writeUInt16LE(CDX_NODE_ROOT | CDX_NODE_LEAF, 0);
    directory.writeUInt16LE(directoryEntries.length, 2);
    directory.writeInt32LE(-1, 4);
    directory.writeInt32LE(-1, 8);
    const directoryKeyLength = 10;
    const directoryRecBits = bitsForMax(directoryEntries.reduce((max, e) => Math.max(max, e.headerPage * CDX_PAGE_LEN), 0));
    const directoryReqByte = Math.ceil(directoryRecBits / 8);
    const directoryRecMask = (1 << directoryRecBits) - 1;
    directory.writeUInt16LE(CDX_PAGE_LEN - CDX_EXT_HEADER_LEN - directoryEntries.length * directoryReqByte, 12);
    directory.writeUInt32LE(directoryRecMask, 14);
    directory[18] = 0;
    directory[19] = 0;
    directory[20] = directoryRecBits;
    directory[21] = 1;
    directory[22] = 1;
    directory[23] = directoryReqByte;
    let directoryKeyPos = CDX_PAGE_LEN;
    for (let i = 0; i < directoryEntries.length; ++i) {
        const entry = directoryEntries[i];
        const offset = CDX_EXT_HEADER_LEN + i * directoryReqByte;
        const packed = (entry.headerPage * CDX_PAGE_LEN) & directoryRecMask;
        for (let b = 0; b < directoryReqByte; ++b) directory[offset + b] = (packed >>> (b * 8)) & 0xff;
        directoryKeyPos -= directoryKeyLength;
        entry.name.copy(directory, directoryKeyPos, 0, directoryKeyLength);
    }

    // Write the file header (page 0).
    const fileHeader = allocator.pages[0];
    fileHeader.writeUInt32LE(directoryPage * CDX_PAGE_LEN, 0);
    fileHeader.writeInt32LE(0, 4);
    fileHeader.writeUInt32BE(0, 8);
    fileHeader.writeUInt16LE(directoryKeyLength, 12);
    fileHeader[14] = (production ? CDX_TYPE_STRUCTURE : 0) | CDX_TYPE_COMPOUND | CDX_TYPE_COMPACT;
    fileHeader[15] = 0x01;

    return Buffer.concat(allocator.pages);
}
