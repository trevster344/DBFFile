import {expect} from 'chai';
import {DBFFile, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';




describe('Sequiter CodeBase expression compatibility', () => {

    const fixtures = path.join(__dirname, './fixtures');
    const fields: FieldDescriptor[] = [{name: 'CODE', type: 'C', size: 8}];

    // Chosen so that ordering by the leftmost 4 chars (CodeBase RIGHT) differs from ordering by the
    // rightmost 4 chars (standard RIGHT).
    const records = [
        {CODE: 'aaaabbbb'},
        {CODE: 'bbbbaaaa'},
        {CODE: 'ccccdddd'},
        {CODE: 'ddddcccc'},
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

    async function expectReject(action: Promise<unknown>, pattern: RegExp) {
        let error: Error | undefined;
        try { await action; }
        catch (err) { error = err as Error; }
        expect(error, 'expected the operation to be rejected').to.be.an('error');
        expect(error!.message).to.match(pattern);
    }

    it('builds keys with CodeBase RIGHT semantics and reads in that order', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-codebase');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                expressionCompat: 'codebase',
                indexes: [{tag: 'RB', expression: 'RIGHT(CODE,4)'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30, expressionCompat: 'codebase'});
            const codes = (await reopened.readRecords({index: 'RB'})).map(r => r.CODE);
            // Leftmost-4 order: aaaa < bbbb < cccc < dddd (unchanged from insertion order here).
            expect(codes).deep.equals(['aaaabbbb', 'bbbbaaaa', 'ccccdddd', 'ddddcccc']);
            await reopened.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('reindexes a CodeBase-built tag under compat, but refuses under standard semantics unless forced', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-codebase-guard');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                expressionCompat: 'codebase',
                indexes: [{tag: 'RB', expression: 'RIGHT(CODE,4)'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            // A standard-semantics reindex cannot reproduce the keys, so it must refuse.
            const standard = await DBFFile.open(dbfPath, {cdx: 0x30});
            await expectReject(standard.reindex(), /Refusing to reindex/);
            // ... unless explicitly forced.
            await standard.reindex(undefined, {force: true});
            await standard.close();

            // The tag now holds standard keys, so a codebase reindex also refuses.
            const codebase = await DBFFile.open(dbfPath, {cdx: 0x30, expressionCompat: 'codebase'});
            await expectReject(codebase.reindex(), /Refusing to reindex/);
            await codebase.close();

            // But a codebase reindex under compat reproduces its own keys without tripping the guard.
            const again = await DBFFile.open(dbfPath, {cdx: 0x30, expressionCompat: 'codebase'});
            await again.reindex(undefined, {force: true});
            await again.reindex();
            await again.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('maintains index consistency through append, delete, undelete and reindex', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-codebase-ops');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                expressionCompat: 'codebase',
                indexes: [{tag: 'RB', expression: 'RIGHT(CODE,4)', for: '.NOT. DELETED()'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30, expressionCompat: 'codebase'});
            const read = async () => (await reopened.readRecords({index: 'RB', maxCount: 1000000})).map(r => r.CODE);

            await reopened.appendRecords([{CODE: 'eeeeffff'}]);
            let codes = await read();
            expect(codes.length).equals(records.length + 1);
            expect(codes).to.include('eeeeffff');

            await reopened.deleteRecord(0);
            codes = await read();
            expect(codes.length).equals(records.length);

            await reopened.undeleteRecord(0);
            codes = await read();
            expect(codes.length).equals(records.length + 1);

            await reopened.reindex();
            codes = await read();
            expect(codes.length).equals(records.length + 1);
            expect(codes).to.include('eeeeffff');
            await reopened.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('refuses a write-time reindex under the wrong semantics and leaves the index intact', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-codebase-intact');
        await cleanup(dbfPath, cdxPath);
        try {
            const dbf = await DBFFile.create(dbfPath, fields, {
                fileVersion: 0x30,
                expressionCompat: 'codebase',
                indexes: [{tag: 'RB', expression: 'RIGHT(CODE,4)'}],
            });
            await dbf.appendRecords(records);
            await dbf.reindex();
            await dbf.close();

            // Appending under standard semantics must not silently clobber the CodeBase index.
            const standard = await DBFFile.open(dbfPath, {cdx: 0x30});
            await standard.appendRecords([{CODE: 'eeeeffff'}]);
            await expectReject(standard.close(), /Refusing to reindex/);

            // The CodeBase index is untouched (still the original 4 keys).
            const check = await DBFFile.open(dbfPath, {cdx: 0x30, expressionCompat: 'codebase'});
            const codes = (await check.readRecords({index: 'RB', maxCount: 1000000})).map(r => r.CODE);
            expect(codes.length).equals(records.length);
            await check.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });

    it('infers a numeric key type for val() expressions on open', async () => {
        const {dbf: dbfPath, cdx: cdxPath} = paths('cdx-keytype');
        await cleanup(dbfPath, cdxPath);
        try {
            const numFields: FieldDescriptor[] = [{name: 'SNUM', type: 'C', size: 8}];
            const dbf = await DBFFile.create(dbfPath, numFields, {
                fileVersion: 0x30,
                indexes: [{tag: 'SN', expression: 'VAL(SNUM)'}],
            });
            await dbf.appendRecords([{SNUM: '10'}, {SNUM: '2'}, {SNUM: '30'}]);
            await dbf.reindex();
            await dbf.close();

            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect(reopened.tags[0].keyType).equals('N');
            const nums = (await reopened.readRecords({index: 'SN'})).map(r => Number(r.SNUM));
            expect(nums).deep.equals([2, 10, 30]);
            expect((await reopened.seek('SN', 10))?.SNUM).equals('10');
            await reopened.close();
        }
        finally {
            await cleanup(dbfPath, cdxPath);
        }
    });
});
