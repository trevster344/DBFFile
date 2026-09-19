import {expect} from 'chai';
import {DBFFile, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';




describe('Creating and reindexing a CDX', () => {

    const fixtures = path.join(__dirname, './fixtures');
    const fields: FieldDescriptor[] = [
        {name: 'ID', type: 'I', size: 4},
        {name: 'NAME', type: 'C', size: 20},
        {name: 'ACTIVE', type: 'L', size: 1},
    ];

    function paths(name: string) {
        return {
            dbf: path.join(fixtures, name + '.dbf'),
            cdx: path.join(fixtures, name + '.cdx'),
        };
    }

    async function cleanup(...files: string[]) {
        for (const file of files) await fs.unlink(file).catch(() => {});
    }

    const records = Array.from({length: 40}, (_, i) => ({
        ID: (i * 7) % 40,
        NAME: 'name' + String((i * 13) % 40).padStart(3, '0'),
        ACTIVE: i % 3 !== 0,
    }));

    it('creates a production CDX and reads records in tag order', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-create');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'NAME', expression: 'NAME'}, {tag: 'ID', expression: 'ID'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect(reopened.tags.map(t => `${t.name}:${t.keyType}:${t.keyLength}`)).deep.equals(['NAME:C:20', 'ID:N:4']);

            const names = (await reopened.readRecords({index: 'NAME'})).map(r => r.NAME);
            expect(names.length).equals(records.length);
            expect(names).deep.equals([...names].sort());

            const ids = (await reopened.readRecords({index: 'ID'})).map(r => r.ID as number);
            expect(ids.length).equals(records.length);
            expect(ids).deep.equals([...ids].sort((a, b) => a - b));
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('seeks exact keys in a created index', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-seek');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'NAME', expression: 'NAME'}, {tag: 'ID', expression: 'ID'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect((await reopened.seek('NAME', 'name005'))?.NAME).equals('name005');
            expect((await reopened.seek('ID', 21))?.ID).equals(21);
            expect(await reopened.seek('NAME', 'missing')).equals(undefined);
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('supports expression keys', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-expression');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'UPPER', expression: 'UPPER(NAME)'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            const upper = (await reopened.readRecords({index: 'UPPER'})).map(r => String(r.NAME).toUpperCase());
            expect(upper).deep.equals([...upper].sort());
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('applies a FOR filter to the index', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-for');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'ACTIVE', expression: 'NAME', for: 'ACTIVE'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            const indexed = await reopened.readRecords({index: 'ACTIVE'});
            const expected = records.filter(r => r.ACTIVE).length;
            expect(indexed.length).equals(expected);
            for (const record of indexed) expect(record.ACTIVE).equals(true);
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('excludes deleted records from the index after a write', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-delete');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'NAME', expression: 'NAME'}],
            });
            await dbf.appendRecords(records);
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect((await reopened.readRecords({index: 'NAME'})).length).equals(records.length);

            await reopened.deleteRecord(0);
            const after = await reopened.readRecords({index: 'NAME'});
            expect(after.length).equals(records.length - 1);
            expect(reopened.recordCount).equals(records.length);
            await reopened.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('builds a unique index with one entry per key', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-unique');
        await cleanup(dbfPath, cdxPath);
        try {
            const codeFields: FieldDescriptor[] = [{name: 'CODE', type: 'C', size: 4}];
            const dbf = await DBFFile.create(dbfPath, codeFields, {
                fileVersion: 0x30,
                indexes: [{tag: 'CODE', expression: 'CODE', unique: true}],
            });
            await dbf.appendRecords([{CODE: 'A'}, {CODE: 'B'}, {CODE: 'A'}, {CODE: 'C'}, {CODE: 'B'}]);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect(reopened.tags[0].unique).equals(true);
            const codes = (await reopened.readRecords({index: 'CODE'})).map(r => r.CODE);
            expect(codes).deep.equals(['A', 'B', 'C']);
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('reads a descending tag in reverse order', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-desc');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'NAME', expression: 'NAME', descending: true}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect(reopened.tags[0].descending).equals(true);
            const names = (await reopened.readRecords({index: 'NAME'})).map(r => r.NAME);
            expect(names).deep.equals([...names].sort().reverse());
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('detects records appended by another process and rebuilds the index', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-external');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'NAME', expression: 'NAME'}],
            });
            await dbf.appendRecords(records.slice(0, 5));
            await dbf.close();

            const reader = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect((await reader.readRecords({index: 'NAME'})).length).equals(5);

            // Simulate another process appending directly to the DBF on disk.
            const writer = await DBFFile.open(dbfPath);
            await writer.appendRecords([{ID: 999, NAME: 'zzz-external', ACTIVE: true}]);
            await writer.close();

            // The next index read must notice the on-disk change and rebuild.
            const after = await reader.readRecords({index: 'NAME'});
            expect(after.length).equals(6);
            expect(after[after.length - 1].NAME).equals('zzz-external');
            expect((await reader.seek('NAME', 'zzz-external'))?.ID).equals(999);
            await reader.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('marks the DBF as having a structural index', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-flag');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                indexes: [{tag: 'NAME', expression: 'NAME'}],
            });
            await dbf.close();
            const raw = await fs.readFile(dbfPath);
            expect(raw[28] & 0x01, 'structural CDX flag should be set').equals(0x01);
            // Field descriptor index flag for NAME (second field) should be set.
            const headerLength = raw.readUInt16LE(8);
            const fieldCount = (headerLength - 34) / 32;
            expect(fieldCount).equals(3);
            expect(raw[32 + 1 * 32 + 0x1F]).equals(0x01);
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });
});
