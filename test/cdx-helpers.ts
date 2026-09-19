import {expect} from 'chai';
import {CdxExpression, CdxTagInfo, collationForName, DBFFile, DELETED, encodeCdxKey} from 'dbffile';




/** Builds an expression evaluation context over a raw (padded) record. */
export function contextFor(record: any) {
    return {
        getField: (name: string) => {
            const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
            const value = key ? record[key] : undefined;
            return value === undefined || value === null ? null : value as any;
        },
        isDeleted: () => record[DELETED] === true,
    };
}




/** Reads every record (including deleted) with character fields left padded, for key computation. */
export async function allRecords(dbf: DBFFile): Promise<Array<Record<string, unknown>>> {
    const savedRaw = dbf._rawCharacterFields;
    const savedInclude = dbf._includeDeletedRecords;
    dbf._rawCharacterFields = true;
    dbf._includeDeletedRecords = true;
    dbf._recordsRead = 0;
    try {
        return await dbf.readRecords(1000000);
    }
    finally {
        dbf._rawCharacterFields = savedRaw;
        dbf._includeDeletedRecords = savedInclude;
    }
}




/**
 * The integrity validator: leaf-link consistency, logical key ordering, record-number bounds and
 * uniqueness, and (optionally) full coverage of every non-deleted record.
 */
export function validateIndexIntegrity(dbf: DBFFile, tag: CdxTagInfo, expectFullCoverage: boolean): {entries: Array<{key: Buffer, recno: number}>, recnos: Set<number>, leafCount: number} {
    const cdx = dbf._cdx!;
    const leaves = cdx.leaves(tag.name);
    if (leaves.length) {
        expect(leaves[0].left, `${tag.name}: first leaf left link`).equals(-1);
        expect(leaves[leaves.length - 1].right, `${tag.name}: last leaf right link`).equals(-1);
        for (let i = 0; i < leaves.length - 1; ++i) {
            expect(leaves[i].right, `${tag.name}: leaf ${i} right -> next`).equals(leaves[i + 1].page);
            expect(leaves[i + 1].left, `${tag.name}: leaf ${i + 1} left -> prev`).equals(leaves[i].page);
        }
    }

    const entries = [...cdx.iterateTag(tag.name)];
    const counted = leaves.reduce((sum, leaf) => sum + leaf.count, 0);
    expect(entries.length, `${tag.name}: entries vs leaf counts`).equals(counted);

    const seen = new Set<number>();
    const pad = tag.keyType === 'C' ? 0x20 : 0x00;
    const logical = (key: Buffer) => {
        let end = key.length;
        while (end > 0 && key[end - 1] === pad) --end;
        return key.subarray(0, end);
    };
    let previous: Buffer | undefined;
    for (const entry of entries) {
        expect(entry.recno, `${tag.name}: recno in range`).to.be.greaterThan(0);
        expect(entry.recno, `${tag.name}: recno in range`).to.be.lessThan(dbf.recordCount + 1);
        expect(seen.has(entry.recno), `${tag.name}: recno ${entry.recno} unique`).equals(false);
        seen.add(entry.recno);
        if (previous) expect(Buffer.compare(previous, logical(entry.key)), `${tag.name}: keys sorted`).to.be.lessThanOrEqual(0);
        previous = logical(entry.key);
    }

    if (expectFullCoverage) expect(seen.size, `${tag.name}: full coverage`).equals(dbf.recordCount);
    return {entries, recnos: seen, leafCount: leaves.length};
}




/** Verifies every stored key equals the key computed from the record's padded fields. */
export function verifyKeys(dbf: DBFFile, tag: CdxTagInfo, records: Array<Record<string, unknown>>, encoding: string): void {
    const expression = CdxExpression.parse(tag.keyExpression);
    const collation = collationForName(tag.collation);
    for (const entry of dbf._cdx!.iterateTag(tag.name)) {
        const record = records[entry.recno - 1];
        const value = expression.evaluate(contextFor(record));
        const expected = encodeCdxKey(value, tag.keyType, tag.keyLength, collation, encoding);
        expect(expected.toString('hex'), `${tag.name}: key for recno ${entry.recno}`).equals(entry.key.toString('hex'));
    }
}
