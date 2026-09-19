import {expect} from 'chai';
import {DBFFile, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';




describe('Updating records in place', () => {

    const fixtures = path.join(__dirname, './fixtures');
    const fields: FieldDescriptor[] = [
        {name: 'ID', type: 'N', size: 5},
        {name: 'NAME', type: 'C', size: 20},
        {name: 'VAL', type: 'N', size: 10},
    ];

    async function createFile(name: string, count: number): Promise<{dbfPath: string, records: Array<Record<string, unknown>>}> {
        const dbfPath = path.join(fixtures, name);
        await fs.unlink(dbfPath).catch(() => {});
        const dbf = await DBFFile.create(dbfPath, fields);
        const records = Array.from({length: count}, (_, i) => ({ID: i, NAME: `name${i}`, VAL: i}));
        if (count) await dbf.appendRecords(records);
        return {dbfPath, records};
    }

    it('updates a single record without rewriting the rest of the file', async () => {
        const {dbfPath} = await createFile('inplace-single.dbf', 20);
        try {
            const dbf = await DBFFile.open(dbfPath);
            const records = await dbf.readRecords(100000);
            const index = 5;

            const before = await fs.readFile(dbfPath);
            await dbf.updateRecord(index, {...records[index], NAME: 'CHANGED'});
            const after = await fs.readFile(dbfPath);

            // The record count must not change.
            expect(dbf.recordCount).equals(20);

            // Only the target record's bytes (and the header's date bytes 1-3) may change.
            const start = dbf._headerLength + index * dbf._recordLength;
            const end = start + dbf._recordLength;
            for (let i = 0; i < before.length; ++i) {
                if (i >= 1 && i < 4) continue;
                if (i >= start && i < end) continue;
                if (before[i] !== after[i]) {
                    throw new Error(`Byte ${i} changed outside the target record`);
                }
            }

            // The change must be visible after reopening, and other records must be intact.
            const reopened = await DBFFile.open(dbfPath);
            const updated = await reopened.readRecords(100000);
            expect(updated.length).equals(20);
            expect(updated[index].NAME).equals('CHANGED');
            for (let i = 0; i < records.length; ++i) {
                if (i === index) continue;
                expect(updated[i]).deep.equals(records[i]);
            }
        }
        finally {
            await fs.unlink(dbfPath).catch(() => {});
        }
    });

    it('updates multiple records in one call', async () => {
        const {dbfPath, records} = await createFile('inplace-multi.dbf', 10);
        try {
            const dbf = await DBFFile.open(dbfPath);
            await dbf.updateRecords([
                {index: 0, record: {...records[0], NAME: 'AAA'}},
                {index: 2, record: {...records[2], NAME: 'CCC'}},
            ]);

            const reopened = await DBFFile.open(dbfPath);
            const updated = await reopened.readRecords(100000);
            expect(updated.length).equals(10);
            expect(updated[0].NAME).equals('AAA');
            expect(updated[2].NAME).equals('CCC');
            expect(updated[1]).deep.equals(records[1]);
        }
        finally {
            await fs.unlink(dbfPath).catch(() => {});
        }
    });

    it('refreshes the date of last update', async () => {
        const {dbfPath, records} = await createFile('inplace-date.dbf', 1);
        try {
            const dbf = await DBFFile.open(dbfPath);
            await dbf.updateRecord(0, {...records[0], NAME: 'Q'});

            const reopened = await DBFFile.open(dbfPath);
            const today = new Date().toISOString().slice(0, 10);
            expect(reopened.dateOfLastUpdate.toISOString().slice(0, 10)).equals(today);
        }
        finally {
            await fs.unlink(dbfPath).catch(() => {});
        }
    });

    it('rejects out-of-range record indices', async () => {
        const {dbfPath, records} = await createFile('inplace-range.dbf', 3);
        try {
            const dbf = await DBFFile.open(dbfPath);
            let error: any;
            try {
                await dbf.updateRecord(dbf.recordCount, records[0]);
            }
            catch (err) {
                error = err;
            }
            expect(error, 'an out-of-range index should throw').to.be.instanceOf(Error);
            expect(error.message).contains('out of range');
        }
        finally {
            await fs.unlink(dbfPath).catch(() => {});
        }
    });

    it('updates memo values in place, leaving other records and memos intact', async () => {
        const dbfPath = path.join(fixtures, 'dbase_83.dbf.inplace.out');
        const memoPath = path.join(fixtures, 'dbase_83.dbf.inplace.dbt');
        await fs.copyFile(path.join(fixtures, 'dbase_83.dbf'), dbfPath);
        await fs.copyFile(path.join(fixtures, 'dbase_83.dbt'), memoPath);
        try {
            let dbf = await DBFFile.open(dbfPath);
            const records = await dbf.readRecords(100000);
            const last = records.length - 1;

            await dbf.updateRecord(last, {...records[last], DESC: 'memo updated in place'});

            dbf = await DBFFile.open(dbfPath);
            const updated = await dbf.readRecords(100000);
            expect(updated.length).equals(records.length);
            expect(updated[last].DESC).equals('memo updated in place');
            for (let i = 0; i < records.length; ++i) {
                if (i === last) continue;
                expect(updated[i].DESC).equals(records[i].DESC);
                expect(updated[i].ID).equals(records[i].ID);
            }
        }
        finally {
            await fs.unlink(dbfPath).catch(() => {});
            await fs.unlink(memoPath).catch(() => {});
        }
    });
});
