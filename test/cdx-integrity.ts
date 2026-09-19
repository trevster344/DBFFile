import {expect} from 'chai';
import {DBFFile} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';
import {allRecords, validateIndexIntegrity, verifyKeys} from './cdx-helpers';




interface Fixture {
    name: string;
    dbfExt: '.dbf' | '.DBF';
    cdxExt: '.cdx' | '.CDX';
    memoExt?: '.dbt' | '.fpt' | '.FPT';
    encoding: string;
}




const fixtures: Fixture[] = [
    {name: 'landcode', dbfExt: '.dbf', cdxExt: '.cdx', memoExt: '.fpt', encoding: 'cp850'},
    {name: 'postnrs', dbfExt: '.dbf', cdxExt: '.cdx', encoding: 'cp850'},
    {name: 'klant', dbfExt: '.dbf', cdxExt: '.cdx', memoExt: '.fpt', encoding: 'cp1252'},
    {name: 'FXUResults', dbfExt: '.DBF', cdxExt: '.CDX', memoExt: '.FPT', encoding: 'cp1252'},
];




describe('CDX integrity and original-fixture comparison', function () {

    this.timeout(60000);

    const dir = path.join(__dirname, './fixtures/cdx');
    const tmp: string[] = [];

    function paths(fixture: Fixture) {
        const base = path.join(dir, fixture.name);
        return {
            dbf: base + fixture.dbfExt,
            cdx: base + fixture.cdxExt,
            memo: fixture.memoExt ? base + fixture.memoExt : undefined,
        };
    }

    afterEach(async () => {
        while (tmp.length) await fs.unlink(tmp.pop()!).catch(() => {});
    });

    async function copyToTemp(fixture: Fixture, prefix: string) {
        const base = path.join(dir, prefix + fixture.name);
        const source = paths(fixture);
        tmp.push(base + fixture.dbfExt, base + fixture.cdxExt);
        if (fixture.memoExt) tmp.push(base + fixture.memoExt);
        await fs.copyFile(source.dbf, base + fixture.dbfExt);
        await fs.copyFile(source.cdx, base + fixture.cdxExt);
        if (source.memo && fixture.memoExt) await fs.copyFile(source.memo, base + fixture.memoExt);
        return base + fixture.dbfExt;
    }

    fixtures.forEach(fixture => {
        it(`validates the original '${fixture.name}' index (integrity + key correctness)`, async () => {
            const opened = await DBFFile.open(paths(fixture).dbf, {cdx: 0x30, encoding: fixture.encoding});
            const records = await allRecords(opened);
            for (const tag of opened.tags) {
                validateIndexIntegrity(opened, tag, !tag.filtered && !tag.unique);
                verifyKeys(opened, tag, records, fixture.encoding);
            }
        });

        it(`reindexes '${fixture.name}' to the same keys and record order as the original`, async () => {
            const dbfPath = await copyToTemp(fixture, 'rt-');

            const before = await DBFFile.open(dbfPath, {cdx: 0x30, encoding: fixture.encoding});
            const originalEntries: Record<string, string> = {};
            for (const tag of before.tags) {
                originalEntries[tag.name] = [...before._cdx!.iterateTag(tag.name)]
                    .map(e => `${e.key.toString('hex')}#${e.recno}`).join(',');
            }

            await before.reindex();
            await before.close();

            const after = await DBFFile.open(dbfPath, {cdx: 0x30, encoding: fixture.encoding});
            for (const tag of after.tags) {
                const rebuilt = [...after._cdx!.iterateTag(tag.name)]
                    .map(e => `${e.key.toString('hex')}#${e.recno}`).join(',');
                expect(rebuilt, `${tag.name}: rebuilt index must match the original`).equals(originalEntries[tag.name]);
                validateIndexIntegrity(after, tag, !tag.filtered && !tag.unique);
            }
        });
    });

    it('validates a generated index that spans multiple leaf and interior pages', async () => {
        const dbfPath = path.join(dir, 'integrity-large.dbf');
        const cdxPath = path.join(dir, 'integrity-large.cdx');
        tmp.push(dbfPath, cdxPath);
        const dbf = await DBFFile.create(dbfPath, [
            {name: 'ID', type: 'I', size: 4},
            {name: 'KEY', type: 'C', size: 60},
        ], {
            fileVersion: 0x30,
            indexes: [{tag: 'KEY', expression: 'KEY'}],
        });
        const records = Array.from({length: 200}, (_, i) => ({ID: i, KEY: 'key-' + String(i).padStart(5, '0') + '-' + 'x'.repeat(40)}));
        await dbf.appendRecords(records);
        await dbf.reindex();
        await dbf.close();

        const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
        const result = validateIndexIntegrity(reopened, reopened.tags[0], true);
        expect(result.leafCount, 'the index should span multiple leaves').to.be.greaterThan(1);
        expect(result.entries.length).equals(200);
    });

    it('throws a descriptive error for a truncated index', async () => {
        const dbfPath = path.join(dir, 'integrity-corrupt.dbf');
        const cdxPath = path.join(dir, 'integrity-corrupt.cdx');
        tmp.push(dbfPath, cdxPath);
        const dbf = await DBFFile.create(dbfPath, [{name: 'ID', type: 'I', size: 4}], {
            fileVersion: 0x30,
            indexes: [{tag: 'ID', expression: 'ID'}],
        });
        await dbf.appendRecords(Array.from({length: 20}, (_, i) => ({ID: i})));
        await dbf.reindex();
        await dbf.close();

        const buffer = await fs.readFile(cdxPath);
        await fs.writeFile(cdxPath, buffer.slice(0, 1024));

        let error: any;
        try {
            const opened = await DBFFile.open(dbfPath, {cdx: 0x30});
            [...opened._cdx!.iterateTag('ID')];
        }
        catch (err) {
            error = err;
        }
        expect(error, 'a truncated index should throw').to.be.instanceOf(Error);
    });
});
