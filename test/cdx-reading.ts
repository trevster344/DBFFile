import {expect} from 'chai';
import {CdxIndex, DBFFile} from 'dbffile';
import * as path from 'path';




describe('Reading a CDX compound index', () => {

    const fixtures = path.join(__dirname, './fixtures/cdx');
    const dbf = (name: string, ext = '.dbf') => path.join(fixtures, name + ext);

    it('parses the file header and tag directory', async () => {
        const index = await CdxIndex.open(path.join(fixtures, 'landcode.cdx'));
        expect(index.header.options).equals(0xe0); // structure | compound | compact
        expect(index.header.keyLength).equals(10);
        expect(index.tags.map(t => t.name)).deep.equals(['CODE']);
        expect(index.tags[0].keyExpression).equals('code');
        expect(index.tags[0].keyLength).equals(6);
        expect(index.tags[0].collation).equals('GENERAL');
    });

    it('parses multiple tags, including filtered ones', async () => {
        const index = await CdxIndex.open(path.join(fixtures, 'postnrs.cdx'));
        expect(index.tags.map(t => t.name)).deep.equals(['NEWPOST', 'PLAATS', 'POSTNR']);

        const landcode = await CdxIndex.open(path.join(fixtures, 'landcode.cdx'));
        expect(landcode.tags[0].forExpression).equals('.NOT.DELETED()');
        expect(landcode.tags[0].filtered).equals(true);
    });

    it('parses expression keys', async () => {
        const index = await CdxIndex.open(path.join(fixtures, 'FXUResults.CDX'));
        const byName: Record<string, string> = {};
        for (const tag of index.tags) byName[tag.name] = tag.keyExpression;
        expect(byName).deep.equals({
            TCLASS_U: 'UPPER(tclass)',
            TCLNAME: 'UPPER(tclass)+UPPER(tname)',
            TCLOC: 'UPPER(tclass)+STR(location)',
            TNAME_U: 'UPPER(tname)',
        });
    });

    it('exposes tags through DBFFile.open when opted in', async () => {
        const opened = await DBFFile.open(dbf('landcode'), {cdx: 0x30});
        expect(opened.tags.map(t => t.name)).deep.equals(['CODE']);
        expect(opened.indexes).to.have.length(1);
    });

    it('ignores any .cdx when not opted in', async () => {
        const opened = await DBFFile.open(dbf('landcode'));
        expect(opened.tags).deep.equals([]);
        expect(opened.indexes).deep.equals([]);
    });

    it('opens VFP 0x31 tables with a production index', async () => {
        const opened = await DBFFile.open(dbf('postnrs'), {cdx: 0x30});
        expect(opened.tags.map(t => t.name)).deep.equals(['NEWPOST', 'PLAATS', 'POSTNR']);
    });

    it('throws when the opted-in index is missing', async () => {
        let error: any;
        try {
            await DBFFile.open(path.join(__dirname, './fixtures/vfp9_30.dbf'), {cdx: 0x30});
        }
        catch (err) {
            error = err;
        }
        expect(error, 'a missing index should throw').to.be.instanceOf(Error);
        expect(error.message).contains('CDX index not found');
    });

    it('throws when the declared compatibility does not match the DBF version', async () => {
        let error: any;
        try {
            await DBFFile.open(dbf('landcode'), {cdx: 0xf5});
        }
        catch (err) {
            error = err;
        }
        expect(error, 'a compatibility mismatch should throw').to.be.instanceOf(Error);
        expect(error.message).contains('does not match DBF version');
    });

    it('accepts an explicit index path', async () => {
        const explicit = path.join(fixtures, 'landcode.cdx');
        const opened = await DBFFile.open(dbf('landcode'), {cdx: {version: 0x30, path: explicit}});
        expect(opened.tags.map(t => t.name)).deep.equals(['CODE']);
    });

    it('reads records in tag order', async () => {
        const opened = await DBFFile.open(dbf('FXUResults', '.DBF'), {cdx: 0x30});
        const ordered = await opened.readRecords({index: 'TNAME_U'});
        const names = ordered.map(r => String(r.TNAME).toUpperCase());
        expect(names.length).equals(opened.recordCount);
        expect(names).deep.equals([...names].sort());
        expect(names[0]).equals('TESTASSERTEQUALS');
    });

    it('reads records in descending-expression order consistently', async () => {
        const opened = await DBFFile.open(dbf('FXUResults', '.DBF'), {cdx: 0x30});
        const ordered = await opened.readRecords({index: 'TCLASS_U'});
        const classes = ordered.map(r => String(r.TCLASS).toUpperCase());
        expect(classes).deep.equals([...classes].sort());
    });

    it('seeks an exact character key', async () => {
        const opened = await DBFFile.open(dbf('FXUResults', '.DBF'), {cdx: 0x30});
        const record = await opened.seek('TNAME_U', 'TESTASSERTEQUALS');
        expect(record).to.not.equal(undefined);
        expect(record!.TNAME).equals('testAssertEquals');
        expect(await opened.seek('TNAME_U', 'NO_SUCH_KEY')).equals(undefined);
    });

    it('seeks an exact numeric key', async () => {
        const opened = await DBFFile.open(dbf('postnrs'), {cdx: 0x30});
        const record = await opened.seek('NEWPOST', 1000);
        expect(record).to.not.equal(undefined);
        expect(record!.NEWPOST).equals(1000);
    });

    it('throws when reading or seeking an unknown tag', async () => {
        const opened = await DBFFile.open(dbf('FXUResults', '.DBF'), {cdx: 0x30});
        let error: any;
        try {
            await opened.readRecords({index: 'NOPE'});
        }
        catch (err) {
            error = err;
        }
        expect(error, 'an unknown tag should throw').to.be.instanceOf(Error);
        expect(error.message).contains("tag 'NOPE' not found");
    });
});
