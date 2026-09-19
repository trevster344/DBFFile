import {expect} from 'chai';
import {DBFFile, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';
import * as rimraf from 'rimraf';




describe('Writing memo fields', () => {

    interface VersionCase {
        version: any;
        memoExt: '.dbt' | '.fpt';
        memoFieldSize: number;
    }

    const versions: VersionCase[] = [
        {version: 0x83, memoExt: '.dbt', memoFieldSize: 10},
        {version: 0x8b, memoExt: '.dbt', memoFieldSize: 10},
        {version: 0x30, memoExt: '.fpt', memoFieldSize: 4},
        {version: 0xf5, memoExt: '.fpt', memoFieldSize: 10},
    ];

    const fixtures = path.join(__dirname, './fixtures');
    const created = path.join(fixtures, 'memo-writing');

    rimraf.sync(created + '*');

    function paths(name: string, memoExt: string) {
        return {
            dbf: path.join(fixtures, name + '.dbf'),
            memo: path.join(fixtures, name + memoExt),
        };
    }

    function fields(memoFieldSize: number): FieldDescriptor[] {
        return [
            {name: 'ID', type: 'N', size: 5},
            {name: 'NOTES', type: 'M', size: memoFieldSize},
        ];
    }

    async function cleanup(dbfPath: string, memoPath: string) {
        await fs.unlink(dbfPath).catch(() => {});
        await fs.unlink(memoPath).catch(() => {});
    }

    versions.forEach(({version, memoExt, memoFieldSize}) => {
        const name = `memo-writing-v${version.toString(16)}`;
        const {dbf: dbfPath, memo: memoPath} = paths(name, memoExt);

        it(`creates, appends and reads back memo values (version 0x${version.toString(16)})`, async () => {
            await cleanup(dbfPath, memoPath);
            const longValue = 'A'.repeat(1500);
            try {
                let dbf = await DBFFile.create(dbfPath, fields(memoFieldSize), {fileVersion: version});
                await dbf.appendRecords([
                    {ID: 1, NOTES: 'short memo'},
                    {ID: 2, NOTES: longValue},
                    {ID: 3, NOTES: ''},
                    {ID: 4, NOTES: null},
                ]);

                dbf = await DBFFile.open(dbfPath);
                const records = await dbf.readRecords(10);
                expect(dbf.recordCount).equals(4);
                expect(records[0].NOTES).equals('short memo');
                expect(records[1].NOTES).equals(longValue);
                expect(records[2].NOTES === null || records[2].NOTES === '').equals(true);
                expect(records[3].NOTES === null || records[3].NOTES === '').equals(true);
            }
            finally {
                await cleanup(dbfPath, memoPath);
            }
        });

        it(`reuses an existing memo chain when the new value fits, else appends (version 0x${version.toString(16)})`, async () => {
            await cleanup(dbfPath, memoPath);
            try {
                const dbf = await DBFFile.create(dbfPath, fields(memoFieldSize), {fileVersion: version});
                await dbf.appendRecords([{ID: 1, NOTES: 'B'.repeat(2000)}]);

                const sizeBefore = (await fs.stat(memoPath)).size;

                // A shorter value must fit the existing chain, leaving the memo file size unchanged.
                await dbf.updateRecord(0, {ID: 1, NOTES: 'tiny'});
                const sizeAfterReuse = (await fs.stat(memoPath)).size;
                expect(sizeAfterReuse, 'reusing a memo chain must not grow the memo file').equals(sizeBefore);

                // A much longer value must be appended, growing the memo file.
                await dbf.updateRecord(0, {ID: 1, NOTES: 'C'.repeat(5000)});
                const sizeAfterAppend = (await fs.stat(memoPath)).size;
                expect(sizeAfterAppend, 'appending a longer memo must grow the memo file').greaterThan(sizeAfterReuse);

                const reopened = await DBFFile.open(dbfPath);
                const records = await reopened.readRecords(10);
                expect(records[0].NOTES).equals('C'.repeat(5000));
                expect(reopened.recordCount).equals(1);
            }
            finally {
                await cleanup(dbfPath, memoPath);
            }
        });

        if (version !== 0x83) {
            it(`honours a custom memo block size (version 0x${version.toString(16)})`, async () => {
                await cleanup(dbfPath, memoPath);
                try {
                    const dbf = await DBFFile.create(dbfPath, fields(memoFieldSize), {fileVersion: version, memoBlockSize: 1024});
                    await dbf.appendRecords([{ID: 1, NOTES: 'D'.repeat(3000)}]);

                    const reopened = await DBFFile.open(dbfPath);
                    const records = await reopened.readRecords(10);
                    expect(records[0].NOTES).equals('D'.repeat(3000));

                    // Verify the block size was actually recorded in the memo file header.
                    const header = await fs.readFile(memoPath);
                    if (version === 0x8b) {
                        expect(header.readUInt32LE(4)).equals(1024);
                    }
                    else if (version === 0x30 || version === 0xf5) {
                        expect(header.readUInt16BE(6)).equals(1024);
                    }
                }
                finally {
                    await cleanup(dbfPath, memoPath);
                }
            });
        }
    });

    it(`appends a memo to an existing VFP9 file that uses block size 1`, async () => {
        const srcDbf = path.join(fixtures, 'vfp9_memo_bs1.dbf');
        const srcMemo = path.join(fixtures, 'vfp9_memo_bs1.fpt');
        const dbfPath = path.join(fixtures, 'memo-writing-bs1.dbf');
        const memoPath = path.join(fixtures, 'memo-writing-bs1.fpt');
        await cleanup(dbfPath, memoPath);
        await fs.copyFile(srcDbf, dbfPath);
        await fs.copyFile(srcMemo, memoPath);
        try {
            const dbf = await DBFFile.open(dbfPath);
            const countBefore = dbf.recordCount;
            await dbf.appendRecords([{CODE: 'z9', NOTES: 'a memo appended into a block-size-1 file'}]);
            const reopened = await DBFFile.open(dbfPath);
            const records = await reopened.readRecords(100);
            expect(reopened.recordCount).equals(countBefore + 1);
            expect(records[records.length - 1].NOTES).equals('a memo appended into a block-size-1 file');
        }
        finally {
            await cleanup(dbfPath, memoPath);
        }
    });

    const fixtureCases = [
        {filename: 'dbase_83.dbf', memoExt: '.dbt', field: 'DESC'},
        {filename: 'dbase_8b.dbf', memoExt: '.dbt', field: 'MEMO'},
        {filename: 'vfp9_30_memo.dbf', memoExt: '.fpt', field: 'MEMO'},
    ];

    fixtureCases.forEach(({filename, memoExt, field}) => {
        it(`updates a memo value in the existing fixture '${filename}'`, async () => {
            const dbfPath = path.join(fixtures, 'memo-writing-' + filename);
            const memoPath = dbfPath.slice(0, -4) + memoExt;
            await cleanup(dbfPath, memoPath);
            await fs.copyFile(path.join(fixtures, filename), dbfPath);
            await fs.copyFile(path.join(fixtures, filename.slice(0, -4) + memoExt), memoPath);
            try {
                let dbf = await DBFFile.open(dbfPath);
                const before = await dbf.readRecords(1);
                const original = before[0][field] as string;

                await dbf.updateRecord(0, {...before[0], [field]: 'updated in place'});
                dbf = await DBFFile.open(dbfPath);
                let records = await dbf.readRecords(1);
                expect(records[0][field]).equals('updated in place');

                // A longer value than the original must also round-trip.
                const longer = 'E'.repeat(original.length + 3000);
                await dbf.updateRecord(0, {...records[0], [field]: longer});
                dbf = await DBFFile.open(dbfPath);
                records = await dbf.readRecords(1);
                expect(records[0][field]).equals(longer);
            }
            finally {
                await cleanup(dbfPath, memoPath);
            }
        });
    });
});
