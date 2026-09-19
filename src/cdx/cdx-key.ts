import {CdxKeyType} from './cdx-format';
import {CdxCollation} from './cdx-collation';




/**
 * Compares two stored CDX keys the way FoxPro does: trailing pad bytes are not significant, and a
 * key that is a prefix of another sorts first. `pad` is the tag's trailing byte (space for character
 * keys, NUL otherwise).
 */
export function compareCdxKeys(a: Buffer, b: Buffer, pad: number): number {
    let la = a.length;
    while (la > 0 && a[la - 1] === pad) --la;
    let lb = b.length;
    while (lb > 0 && b[lb - 1] === pad) --lb;
    const n = Math.min(la, lb);
    for (let i = 0; i < n; ++i) {
        const diff = a[i] - b[i];
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return la - lb;
}




/** The trailing pad byte for a key type. */
export function keyPadByte(keyType: CdxKeyType): number {
    return keyType === 'C' ? 0x20 : 0x00;
}




/**
 * Encodes a search value into a CDX index key of the given length and type, in the order-preserving
 * representation used by FoxPro.
 *
 * - Character keys are built by the tag's collation (raw code-page bytes for MACHINE, collation
 *   weights for GENERAL), padded to the key length.
 * - Numeric keys of length 4 use an offset 32-bit integer; longer numeric keys and date/datetime keys
 *   use an order-preserving transform of the IEEE double.
 * - Logical keys are the single byte `T` or `F`.
 */
export function encodeCdxKey(value: unknown, keyType: CdxKeyType, keyLength: number, collation: CdxCollation, encoding = 'cp1252'): Buffer {
    const key = Buffer.alloc(keyLength, keyType === 'C' ? 0x20 : 0x00);
    switch (keyType) {
        case 'C':
            return collation.buildKey(value === null || value === undefined ? '' : String(value), keyLength, encoding);
        case 'N': {
            const num = Number(value);
            if (keyLength === 4) {
                key.writeUInt32BE(((Math.trunc(num) + 0x80000000) >>> 0), 0);
            }
            else {
                doubleToOrdered(num).copy(key, 0, 0, Math.min(8, keyLength));
            }
            break;
        }
        case 'D': {
            const date = value instanceof Date ? value : new Date(String(value));
            const julianDay = Math.floor(date.getTime() / 86_400_000) + 2_440_588;
            doubleToOrdered(julianDay).copy(key, 0, 0, Math.min(8, keyLength));
            break;
        }
        case 'T': {
            const date = value instanceof Date ? value : new Date(String(value));
            const julianDay = Math.floor(date.getTime() / 86_400_000) + 2_440_588;
            doubleToOrdered(julianDay).copy(key, 0, 0, Math.min(8, keyLength));
            break;
        }
        case 'L':
            key.writeUInt8(value ? 0x54 : 0x46, 0);
            break;
    }
    return key;
}




/**
 * Transforms an IEEE double into an 8-byte order-preserving representation: the bytes are reversed
 * (to big-endian) and then, for negatives, all bits are inverted; for non-negatives only the high bit
 * is flipped. This lets the database compare keys with a plain byte comparison.
 */
export function doubleToOrdered(value: number): Buffer {
    const littleEndian = Buffer.alloc(8);
    littleEndian.writeDoubleLE(value, 0);
    const out = Buffer.alloc(8);
    for (let i = 0; i < 8; ++i) out[i] = littleEndian[7 - i];
    if (value < 0) {
        for (let i = 0; i < 8; ++i) out[i] = ~out[i] & 0xff;
    }
    else {
        out[0] ^= 0x80;
    }
    return out;
}




/** Reverses {@link doubleToOrdered}. */
export function orderedToDouble(bytes: Buffer): number {
    const out = Buffer.alloc(8);
    for (let i = 0; i < 8; ++i) out[i] = bytes[7 - i];
    if (out[7] & 0x80) out[7] ^= 0x80;
    else for (let i = 0; i < 8; ++i) out[i] = ~out[i] & 0xff;
    return out.readDoubleLE(0);
}
