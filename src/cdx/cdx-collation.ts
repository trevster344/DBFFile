import * as iconv from 'iconv-lite';
import {
    CP1252_EXPANSIONS,
    CP1252_HEAD,
    CP1252_TAIL,
    CP437_HEAD,
    CP437_TAIL,
    CP850_EXPANSIONS,
    CP850_HEAD,
    CP850_TAIL,
} from './cdx-collation-tables';




/**
 * VFP index collation support.
 *
 * FoxPro CDX indexes store a per-tag "sort sequence" (collation) name in the tag header. `MACHINE`
 * stores the raw code-page bytes; every other sequence (e.g. `GENERAL`) stores a collation *weight*
 * key instead of the text. A `GENERAL` weight table is specific to the table's code page, because the
 * same byte means a different character on each code page.
 *
 * The CP1252/CP437/CP850 GENERAL head/tail weight tables in `cdx-collation-tables.ts` are ported from
 * the CodeBase reference `COLL4ARR.C` (LGPL-3.0, Sequiter Inc.); the CP1252 table was independently
 * ported by the MIT-licensed `crossvault/foxDBF` and verified byte-exact against real VFP9 keys. The
 * collation *ordering* is factual data, not creative expression.
 */




/** A CDX collation: builds the key representation for a tag's key expression. */
export interface CdxCollation {

    /** The collation's VFP sort-sequence name. */
    readonly name: string;

    /** The stored key length for a character field/expression of the given width. */
    keyLengthFor(characterWidth: number): number;

    /** Builds the stored key for a text value, padded to `keyLength`. `encoding` is the table code page. */
    buildKey(text: string, keyLength: number, encoding: string): Buffer;
}




/** MACHINE collation: raw code-page bytes (the VFP default). */
class MachineCollation implements CdxCollation {
    readonly name = 'MACHINE';

    keyLengthFor(characterWidth: number): number {
        return characterWidth;
    }

    buildKey(text: string, keyLength: number, encoding: string): Buffer {
        const key = Buffer.alloc(keyLength, 0x20);
        iconv.encode(text, encoding).copy(key, 0, 0, keyLength);
        return key;
    }
}




interface GeneralTable {
    head: Buffer;
    tail: Buffer;
    expansions: number[][];
}




const GENERAL_TABLES: Record<string, GeneralTable> = {
    '1252': {head: CP1252_HEAD, tail: CP1252_TAIL, expansions: CP1252_EXPANSIONS},
    '437': {head: CP437_HEAD, tail: CP437_TAIL, expansions: CP1252_EXPANSIONS},
    '850': {head: CP850_HEAD, tail: CP850_TAIL, expansions: CP850_EXPANSIONS},
};




function generalTableFor(encoding: string): GeneralTable {
    const normalized = encoding.toLowerCase();
    if (normalized.includes('850')) return GENERAL_TABLES['850'];
    if (normalized.includes('437')) return GENERAL_TABLES['437'];
    return GENERAL_TABLES['1252'];
}




const HEAD_EXPAND = 0xff;
const TAIL_NONE = 0xff;




/** GENERAL collation: the Western-European sort sequence (CP1252 / CP437 / CP850). */
class GeneralCollation implements CdxCollation {
    readonly name = 'GENERAL';

    keyLengthFor(characterWidth: number): number {
        return Math.min(characterWidth * 2, 240);
    }

    buildKey(text: string, keyLength: number, encoding: string): Buffer {
        const table = generalTableFor(encoding);
        const bytes = iconv.encode(text, encoding);

        // VFP keys the trimmed value (trailing source spaces are not part of the key).
        let length = bytes.length;
        while (length > 0 && bytes[length - 1] === 0x20) --length;

        const heads: number[] = [];
        const tails: number[] = [];
        const emit = (byte: number) => {
            const head = table.head[byte];
            if (head !== HEAD_EXPAND) {
                heads.push(head);
                const tail = table.tail[byte];
                if (tail !== TAIL_NONE) tails.push(tail);
            }
            else {
                for (const pair of table.expansions[table.tail[byte]]) emit(pair);
            }
        };
        for (let i = 0; i < length; ++i) emit(bytes[i]);

        // Trailing zero (accent) tail bytes are not stored.
        while (tails.length > 0 && tails[tails.length - 1] === 0) tails.pop();

        const key = Buffer.alloc(keyLength, 0x20);
        Buffer.from(heads.concat(tails)).copy(key, 0, 0, keyLength);
        return key;
    }
}




const collations = new Map<string, CdxCollation>();
collations.set('MACHINE', new MachineCollation());
collations.set('GENERAL', new GeneralCollation());




/** Registers (or replaces) a collation by name (case-insensitive). */
export function registerCdxCollation(collation: CdxCollation): void {
    collations.set(collation.name.toUpperCase(), collation);
}




/** Resolves a collation from a tag's stored sort-sequence name; unknown names fall back to MACHINE. */
export function collationForName(name: string | undefined): CdxCollation {
    if (!name) return collations.get('MACHINE')!;
    return collations.get(name.trim().toUpperCase()) ?? collations.get('MACHINE')!;
}
