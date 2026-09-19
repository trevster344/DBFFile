import * as iconv from 'iconv-lite';
import {close, open, read, stat, write} from './utils';




/**
 * Read/write access to the memo file (.dbt for dBASE, .fpt for FoxPro) that accompanies a DBF file
 * with memo (`M`) fields. Supports the four memo layouts the reader understands:
 *
 * - 0x83 (dBASE III): 512-byte block header, 512-byte fixed blocks, values terminated by 0x1A.
 * - 0x8b (dBASE IV):  block size at offset 4 (LE), values prefixed by FF FF 08 00 + u32 LE length.
 * - 0x30 (VFP9) and 0xf5 (FoxPro 2): next-free block at offset 0 (BE), block size at offset 6 (BE),
 *   values prefixed by a u32 BE type (1 = text) and a u32 BE length.
 *
 * Writes are "reuse when it fits": if a new value fits within the block chain already allocated to an
 * existing memo, that chain is overwritten in place; otherwise the value is appended at the end of the
 * file and the previous chain is orphaned (matching how the classic xBase products behave).
 */
export class MemoFile {
    readonly path: string;
    readonly version: number;
    readonly blockSize: number;
    private fd: number;

    private constructor(path: string, version: number, blockSize: number, fd: number) {
        this.path = path;
        this.version = version;
        this.blockSize = blockSize;
        this.fd = fd;
    }

    /**
     * Creates a new, empty memo file. The header occupies a 512-byte block 0; the initial next-free
     * block is derived from the block size.
     */
    static async create(path: string, version: number, blockSize = 512): Promise<MemoFile> {
        if (blockSize < 512) throw new Error(`Invalid memo block size ${blockSize} (minimum is 512)`);
        const fd = await open(path, 'w');
        try {
            const header = Buffer.alloc(512);
            const nextFree = Math.ceil(512 / blockSize);
            if (version === 0x8b) {
                header.writeUInt32LE(blockSize, 4);
            }
            else if (version === 0x30 || version === 0xf5) {
                header.writeUInt32BE(nextFree, 0);
                header.writeUInt16BE(blockSize, 6);
            }
            await write(fd, header, 0, header.length, 0);
            return new MemoFile(path, version, blockSize, fd);
        }
        catch (err) {
            await close(fd);
            throw err;
        }
    }

    /** Opens an existing memo file for reading and writing. */
    static async open(path: string, version: number): Promise<MemoFile> {
        const fd = await open(path, 'r+');
        try {
            const blockSize = await readBlockSize(fd, version);
            return new MemoFile(path, version, blockSize, fd);
        }
        catch (err) {
            await close(fd);
            throw err;
        }
    }

    /** Closes the underlying file handle. */
    async close(): Promise<void> {
        if (this.fd) {
            await close(this.fd);
            this.fd = 0;
        }
    }

    /**
     * Writes a memo value and returns the block index to store in the DBF record. An empty value
     * returns 0, which the DBF encoder writes as a blank/zero memo reference. When `reuseBlockIndex`
     * is given and the value fits the existing block chain, that chain is reused.
     */
    async writeMemo(value: string | null | undefined, encoding: string, reuseBlockIndex = 0): Promise<number> {
        if (value === null || value === undefined || value === '') return 0;
        const data = iconv.encode(value, encoding);

        // Block size 1 (a VFP9 special case) stores each value at its own byte offset; never reuse.
        if (this.blockSize === 1) {
            return this.appendVariableBlock(data);
        }

        const totalBytes = this.encodedLength(data.length);
        const blocksNeeded = Math.ceil(totalBytes / this.blockSize);

        // Try to reuse the existing chain when the new value fits.
        if (reuseBlockIndex > 0) {
            const allocatedBytes = await this.allocatedBytes(reuseBlockIndex);
            if (allocatedBytes >= totalBytes) {
                await this.writeChain(reuseBlockIndex, data, allocatedBytes);
                return reuseBlockIndex;
            }
        }

        // Otherwise append a fresh chain at the end of the file.
        const fileSize = (await stat(this.path)).size;
        const blockIndex = Math.ceil(fileSize / this.blockSize);
        await this.writeChain(blockIndex, data, blocksNeeded * this.blockSize);
        await this.updateNextFree(blockIndex + blocksNeeded);
        return blockIndex;
    }

    // Number of bytes the encoded memo (including its header/terminator) occupies.
    private encodedLength(dataLength: number): number {
        if (this.version === 0x83) return dataLength + 2; // 0x1A 0x1A terminator
        return dataLength + 8;                            // 8-byte header (0x8b / 0x30 / 0xf5)
    }

    // Writes a memo chain at the given block index, padding the allocation with spaces.
    private async writeChain(blockIndex: number, data: Buffer, allocatedBytes: number): Promise<void> {
        const buffer = Buffer.alloc(allocatedBytes, 0x20);
        let offset = 0;
        if (this.version === 0x83) {
            data.copy(buffer, offset);
            offset += data.length;
            buffer.writeUInt8(0x1A, offset);
            buffer.writeUInt8(0x1A, offset + 1);
        }
        else if (this.version === 0x8b) {
            buffer.writeUInt32LE(0x0008FFFF, offset);
            buffer.writeUInt32LE(data.length + 8, offset + 4);
            data.copy(buffer, offset + 8);
        }
        else {
            buffer.writeUInt32BE(1, offset);              // Type 1 = text
            buffer.writeUInt32BE(data.length, offset + 4);
            data.copy(buffer, offset + 8);
        }
        await write(this.fd, buffer, 0, buffer.length, blockIndex * this.blockSize);
    }

    // Appends a value using the block-size-1 layout (byte offset + u32 BE length + data).
    private async appendVariableBlock(data: Buffer): Promise<number> {
        const fileSize = (await stat(this.path)).size;
        const offset = fileSize;
        const header = Buffer.alloc(8);
        header.writeUInt32BE(1, 0);
        header.writeUInt32BE(data.length, 4);
        await write(this.fd, header, 0, header.length, offset);
        await write(this.fd, data, 0, data.length, offset + 8);
        await this.updateNextFree(offset + 8 + data.length);
        return offset;
    }

    // Number of bytes currently allocated to the chain starting at the given block index.
    private async allocatedBytes(blockIndex: number): Promise<number> {
        const fileSize = (await stat(this.path)).size;
        const start = blockIndex * this.blockSize;
        if (start >= fileSize) return 0;

        if (this.version === 0x83) {
            // Scan whole blocks until the 0x1A terminator is found.
            let position = start;
            while (position < fileSize) {
                const buffer = Buffer.alloc(this.blockSize);
                await read(this.fd, buffer, 0, this.blockSize, position);
                const eos = buffer.indexOf(0x1A);
                if (eos !== -1) return position - start + eos + 1;
                position += this.blockSize;
            }
            return fileSize - start;
        }

        const header = Buffer.alloc(8);
        await read(this.fd, header, 0, 8, start);
        if (this.version === 0x8b) {
            const length = header.readUInt32LE(4);
            if (length < 8) return 0;
            return Math.ceil(length / this.blockSize) * this.blockSize;
        }
        // 0x30 / 0xf5
        const type = header.readUInt32BE(0);
        if (type !== 1) return 0;
        const length = header.readUInt32BE(4);
        return Math.ceil((length + 8) / this.blockSize) * this.blockSize;
    }

    // Updates the header's next-free-block pointer. dBASE III (.dbt) headers are left untouched,
    // since its header block is traditionally reserved and allocation is derived from the file size.
    private async updateNextFree(nextFree: number): Promise<void> {
        if (this.version === 0x83) return;
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32BE(nextFree, 0);
        await write(this.fd, buffer, 0, 4, 0);
    }
}




// Reads the block size from an existing memo file header, defaulting to 512.
async function readBlockSize(fd: number, version: number): Promise<number> {
    const buffer = Buffer.alloc(8);
    if (version === 0x83) {
        return 512;
    }
    if (version === 0x8b) {
        await read(fd, buffer, 0, 4, 4);
        return buffer.readUInt32LE(0) || 512;
    }
    // 0x30 / 0xf5
    await read(fd, buffer, 0, 2, 6);
    return buffer.readUInt16BE(0) || 512;
}
