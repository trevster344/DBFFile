import {expect} from 'chai';
import {CdxExpression, collationForName, DBFFile, DELETED, encodeCdxKey, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';
import {Worker} from './worker-helper';
import {allRecords, contextFor, validateIndexIntegrity} from './cdx-helpers';




/**
 * Multi-client mixed-workload tests: several forked processes read, append, update, delete and
 * undelete against a single DBF (with a production CDX and, in some scenarios, a memo file) at the
 * same time, under lock-aware mode.
 *
 * The invariant asserted for concurrent readers is "consistent snapshot or lock refusal" — a read
 * either returns a coherent result or fails with a lock error; it must never observe torn/partial
 * data. After the writers stop, the final DBF and index must be fully consistent.
 */
describe('Multi-client mixed workload', function () {

    this.timeout(600000);

    const dir = path.join(__dirname, './fixtures');
    const workerPath = path.join(__dirname, 'mixed-worker.js');
    const N = Number(process.env.MIX_SEED ?? 20000);
    const WORKERS = Number(process.env.MIX_WORKERS ?? 4);
    const READERS = Number(process.env.MIX_READERS ?? 3);
    const OPS = Number(process.env.MIX_OPS ?? 150);
    const APPENDS = 20;

    const baseFields: FieldDescriptor[] = [
        {name: 'ID', type: 'I', size: 4},
        {name: 'VAL', type: 'N', size: 10},
        {name: 'NAME', type: 'C', size: 20},
    ];
    const memoFields: FieldDescriptor[] = [...baseFields, {name: 'NOTES', type: 'M', size: 4}];

    function paths(name: string) {
        return {
            dbf: path.join(dir, name + '.dbf'),
            cdx: path.join(dir, name + '.cdx'),
            fpt: path.join(dir, name + '.fpt'),
        };
    }

    async function cleanup(...files: string[]) {
        for (const file of files) await fs.unlink(file).catch(() => {});
    }

    function seedRecords(count: number, memo: boolean): Array<Record<string, unknown>> {
        const records: Array<Record<string, unknown>> = [];
        for (let i = 0; i < count; ++i) {
            records.push(memo
                ? {ID: i, VAL: 0, NAME: 'seed' + String(i).padStart(9, '0'), NOTES: 'memo-' + i}
                : {ID: i, VAL: 0, NAME: 'seed' + String(i).padStart(9, '0')});
        }
        return records;
    }

    async function seed(name: string, fields: FieldDescriptor[], records: Array<Record<string, unknown>>, withIndex: boolean) {
        const {dbf, cdx, fpt} = paths(name);
        await cleanup(dbf, cdx, fpt);
        const dbfFile = await DBFFile.create(dbf, fields, {
            fileVersion: 0x30,
            indexes: withIndex ? [{tag: 'NAME', expression: 'NAME'}, {tag: 'ID', expression: 'ID'}] : undefined,
        });
        if (records.length) await dbfFile.appendRecords(records);
        await dbfFile.close();
        return {dbf, cdx, fpt};
    }

    function delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function range(n: number): number[] {
        return Array.from({length: n}, (_, i) => i);
    }

    // Asserts every reader result was either a consistent snapshot or a lock refusal.
    function assertReaderStats(stats: any, mode: 'refuse' | 'wait'): void {
        expect(stats.ok + stats.refused, 'reader iterations accounted for').to.be.greaterThan(0);
        const codes = Object.keys(stats.codes);
        if (mode === 'refuse') {
            for (const code of codes) expect(code, 'refuse-mode reader may only be refused with EBUSY').equals('EBUSY');
        }
        else {
            for (const code of codes) expect(['ETIMEDOUT'], `wait-mode reader lock code ${code}`).to.include(code);
        }
    }

    function verifyKeysLogical(dbf: DBFFile, tagName: string, records: Array<Record<string, unknown>>): void {
        const tag = dbf._cdx!.findTag(tagName)!;
        const expression = CdxExpression.parse(tag.keyExpression);
        const collation = collationForName(tag.collation);
        const pad = tag.keyType === 'C' ? 0x20 : 0x00;
        const logical = (key: Buffer) => {
            let end = key.length;
            while (end > 0 && key[end - 1] === pad) --end;
            return key.subarray(0, end);
        };
        for (const entry of dbf._cdx!.iterateTag(tagName)) {
            const expected = encodeCdxKey(expression.evaluate(contextFor(records[entry.recno - 1])), tag.keyType, tag.keyLength, collation, dbf._encoding as string);
            expect(Buffer.compare(logical(expected), logical(entry.key)), `${tagName}: key for recno ${entry.recno}`).equals(0);
        }
    }

    // Opens the final file and asserts the index is a complete, correct reflection of the DBF.
    async function verifyFinal(dbfPath: string, tags: string[], expectedRecordCount: number, expectedDeleted: number, cdx?: 0x30 | 0xf5) {
        const dbf = await DBFFile.open(dbfPath, {cdx, readMode: 'loose'});
        expect(dbf.recordCount, 'final record count').equals(expectedRecordCount);
        const records = await allRecords(dbf);
        const nonDeleted = records.filter(record => (record as any)[DELETED] !== true).length;
        expect(dbf.recordCount - nonDeleted, 'final deleted count').equals(expectedDeleted);
        for (const tagName of tags) {
            const integrity = validateIndexIntegrity(dbf, dbf._cdx!.findTag(tagName)!, false);
            expect(integrity.recnos.size, `${tagName}: coverage of live records`).equals(nonDeleted);
            verifyKeysLogical(dbf, tagName, records);
        }
        await dbf.close();
        return records;
    }

    it('stays consistent under a comprehensive read/write/delete mixed workload', async () => {
        for (const mode of ['refuse', 'wait'] as const) {
            const name = 'mixed-all-' + mode;
            const {dbf: dbfPath, cdx, fpt} = await seed(name, baseFields, seedRecords(N, false), true);
            const readWaitTimeout = mode === 'wait' ? 5000 : 0;
            const chunk = Math.floor(N / WORKERS);
            const undelete = Math.floor(OPS / 2);
            const expectedDeleted = WORKERS * (OPS - undelete);

            try {
                const writers = range(WORKERS).map(w => {
                    const start = w * chunk;
                    const updateIndices = range(OPS).map(k => start + 2 * k);
                    const deleteIndices = range(OPS).map(k => start + 2 * OPS + 2 * k);
                    const undeleteIndices = deleteIndices.slice(0, undelete);
                    const appendRecords = range(APPENDS).map(j => ({ID: N + w * APPENDS + j, VAL: 0, NAME: `app${w}-${String(j).padStart(8, '0')}`}));
                    return new Worker(workerPath, {
                        op: 'mixedScript',
                        dbfPath, cdx: 0x30, readWaitTimeout,
                        steps: [
                            {kind: 'append', records: appendRecords},
                            {kind: 'update', indices: updateIndices, namePrefix: `u${w}-`},
                            {kind: 'delete', indices: deleteIndices},
                            {kind: 'undelete', indices: undeleteIndices},
                            {kind: 'reindex'},
                        ],
                    });
                });
                const readers = range(READERS).map((r) => new Worker(workerPath, {
                    op: 'readLoop',
                    dbfPath, cdx: 0x30, readWaitTimeout,
                    tag: r % 2 === 0 ? 'NAME' : undefined,
                    iterations: 30, delayMs: 5, maxCount: 500,
                }));

                await Promise.all([...writers, ...readers].map(worker => worker.start()));
                const writerResults = await Promise.all(writers.map(worker => worker.getResult()));
                const readerResults = await Promise.all(readers.map(worker => worker.getResult()));

                for (const result of writerResults) expect(result.ok).equals(true);
                for (const stats of readerResults) assertReaderStats(stats, mode);
                expect(readerResults.reduce((sum, stats) => sum + stats.ok, 0), 'at least some reads succeed').to.be.greaterThan(0);

                await verifyFinal(dbfPath, ['NAME', 'ID'], N + WORKERS * APPENDS, expectedDeleted, 0x30);
            }
            finally {
                await cleanup(dbfPath, cdx, fpt);
            }
        }
    });

    it('never exposes a partial index to readers during reindexing', async () => {
        const {dbf: dbfPath, cdx, fpt} = await seed('mixed-reindex', baseFields, seedRecords(N, false), true);
        try {
            const reindexer = new Worker(workerPath, {
                op: 'mixedScript', dbfPath, cdx: 0x30,
                steps: range(15).map(() => ({kind: 'reindex' as const})),
            });
            // Default indexReadWaitTimeout (10s): readers wait for the brief exclusive index lock.
            const readers = range(READERS).map(() => new Worker(workerPath, {
                op: 'readLoop', dbfPath, cdx: 0x30, tag: 'NAME', iterations: 30, delayMs: 5, maxCount: 500,
            }));

            await Promise.all([reindexer, ...readers].map(worker => worker.start()));
            await reindexer.getResult();
            const stats = await Promise.all(readers.map(worker => worker.getResult()));
            for (const result of stats) {
                expect(result.refused, 'readers wait for the index lock and should not be refused').equals(0);
                expect(result.ok).equals(30);
            }

            await verifyFinal(dbfPath, ['NAME', 'ID'], N, 0, 0x30);
        }
        finally {
            await cleanup(dbfPath, cdx, fpt);
        }
    });

    it('honours indexReadWaitTimeout for a contended index lock', async () => {
        const {dbf: dbfPath, cdx, fpt} = await seed('mixed-indexlock', baseFields, seedRecords(50, false), true);
        try {
            const holder = new Worker(workerPath, {op: 'holdIndexLock', dbfPath, cdx: 0x30});
            await holder.start();
            await holder.waitForMessage('locked');

            // indexReadWaitTimeout: 0 -> refuse immediately.
            const refused = await new Worker(workerPath, {op: 'readIndex', dbfPath, cdx: 0x30, tag: 'NAME', indexReadWaitTimeout: 0}).start().then(w => w.getResult());
            expect(refused.ok).equals(false);
            expect(refused.code).equals('EBUSY');

            // Default timeout -> waits, then succeeds once released.
            const waiting = new Worker(workerPath, {op: 'readIndex', dbfPath, cdx: 0x30, tag: 'NAME'});
            await waiting.start();
            const pending = waiting.getResult();
            await delay(300);
            holder.send('release');
            await holder.getResult();
            const result = await pending;
            expect(result.ok).equals(true);
            expect(result.count).equals(50);
        }
        finally {
            await cleanup(dbfPath, cdx, fpt);
        }
    });

    it('keeps the index consistent through a concurrent delete/undelete storm', async () => {
        const {dbf: dbfPath, cdx, fpt} = await seed('mixed-delundelete', baseFields, seedRecords(N, false), true);
        const chunk = Math.floor(N / WORKERS);
        const perWorker = Math.min(OPS, 100);
        // Every worker deletes then undeletes the same indices, so the final deleted count is 0.
        try {
            const workers = range(WORKERS).map(w => new Worker(workerPath, {
                op: 'mixedScript', dbfPath, cdx: 0x30,
                steps: [
                    {kind: 'delete', indices: range(perWorker).map(k => w * chunk + 2 * k)},
                    {kind: 'undelete', indices: range(perWorker).map(k => w * chunk + 2 * k)},
                    {kind: 'reindex'},
                ],
            }));
            const readers = range(READERS).map(() => new Worker(workerPath, {
                op: 'readLoop', dbfPath, cdx: 0x30, tag: 'NAME', iterations: 30, delayMs: 5, maxCount: 500,
            }));

            await Promise.all([...workers, ...readers].map(worker => worker.start()));
            await Promise.all(workers.map(worker => worker.getResult()));
            for (const stats of await Promise.all(readers.map(worker => worker.getResult()))) assertReaderStats(stats, 'refuse');

            await verifyFinal(dbfPath, ['NAME', 'ID'], N, 0, 0x30);
        }
        finally {
            await cleanup(dbfPath, cdx, fpt);
        }
    });

    it('serializes same-record contention under a CDX index', async () => {
        const {dbf: dbfPath, cdx, fpt} = await seed('mixed-samerecord', baseFields, [{ID: 0, VAL: 0, NAME: 'seed000000000'}], true);
        const perWorker = 25;
        try {
            const workers = range(WORKERS).map(() => new Worker(workerPath, {
                op: 'increment', dbfPath, cdx: 0x30, index: 0, field: 'VAL', value: 1, iterations: perWorker,
            }));
            await Promise.all(workers.map(worker => worker.start()));
            await Promise.all(workers.map(worker => worker.getResult()));

            const dbf = await DBFFile.open(dbfPath, {cdx: 0x30});
            const records = await dbf.readRecords(10);
            expect(records[0].VAL, 'every increment must be preserved').equals(WORKERS * perWorker);
            const found = await dbf.seek('ID', 0);
            expect(found?.VAL).equals(WORKERS * perWorker);
            validateIndexIntegrity(dbf, dbf.tags.find(t => t.name === 'ID')!, false);
            await dbf.close();
        }
        finally {
            await cleanup(dbfPath, cdx, fpt);
        }
    });

    it('keeps memo values and the index consistent under concurrent CDX + memo writes', async () => {
        // Memo reads are comparatively expensive, so this scenario uses a smaller table.
        const memoN = Math.min(N, 2000);
        const {dbf: dbfPath, cdx, fpt} = await seed('mixed-memo', memoFields, seedRecords(memoN, true), true);
        const chunk = Math.floor(memoN / WORKERS);
        const perWorker = Math.min(OPS, 80);
        const expectedDeleted = WORKERS * perWorker;
        try {
            const workers = range(WORKERS).map(w => new Worker(workerPath, {
                op: 'mixedScript', dbfPath, cdx: 0x30,
                steps: [
                    {kind: 'append', records: range(APPENDS).map(j => ({ID: memoN + w * APPENDS + j, VAL: 0, NAME: `m${w}-${String(j).padStart(8, '0')}`, NOTES: `memo-app-${w}-${j}-` + 'y'.repeat(j % 40)}))},
                    {kind: 'update', indices: range(perWorker).map(k => w * chunk + 2 * k), namePrefix: `mu${w}-`},
                    {kind: 'delete', indices: range(perWorker).map(k => w * chunk + 2 * perWorker + 2 * k)},
                    {kind: 'reindex'},
                ],
            }));
            const readers = range(READERS).map(() => new Worker(workerPath, {
                op: 'readLoop', dbfPath, cdx: 0x30, tag: 'NAME', iterations: 30, delayMs: 5, maxCount: 500,
            }));

            await Promise.all([...workers, ...readers].map(worker => worker.start()));
            await Promise.all(workers.map(worker => worker.getResult()));
            for (const stats of await Promise.all(readers.map(worker => worker.getResult()))) assertReaderStats(stats, 'refuse');

            const records = await verifyFinal(dbfPath, ['NAME', 'ID'], memoN + WORKERS * APPENDS, expectedDeleted, 0x30);

            // Memo values round-trip: appended records and updated records carry their memo text.
            for (let w = 0; w < WORKERS; ++w) {
                for (let j = 0; j < APPENDS; ++j) {
                    const record = records.find(r => Number(r.ID) === memoN + w * APPENDS + j)!;
                    expect(record.NOTES, `appended memo ${w}-${j}`).equals(`memo-app-${w}-${j}-` + 'y'.repeat(j % 40));
                }
            }
        }
        finally {
            await cleanup(dbfPath, cdx, fpt);
        }
    });

    it('stays consistent under a plain-DBF (no index) mixed workload', async () => {
        const {dbf: dbfPath, cdx, fpt} = await seed('mixed-plain', baseFields, seedRecords(N, false), false);
        const chunk = Math.floor(N / WORKERS);
        const perWorker = Math.min(OPS, 100);
        const expectedDeleted = WORKERS * perWorker;
        try {
            const writers = range(WORKERS).map(w => new Worker(workerPath, {
                op: 'mixedScript', dbfPath,
                steps: [
                    {kind: 'append', records: range(APPENDS).map(j => ({ID: N + w * APPENDS + j, VAL: 0, NAME: `p${w}-${String(j).padStart(8, '0')}`}))},
                    {kind: 'update', indices: range(perWorker).map(k => w * chunk + 2 * k), namePrefix: `pu${w}-`},
                    {kind: 'delete', indices: range(perWorker).map(k => w * chunk + 2 * perWorker + 2 * k)},
                ],
            }));
            const readers = range(READERS).map(() => new Worker(workerPath, {
                op: 'readLoop', dbfPath, iterations: 30, delayMs: 5, maxCount: 500,
            }));

            await Promise.all([...writers, ...readers].map(worker => worker.start()));
            await Promise.all(writers.map(worker => worker.getResult()));
            for (const stats of await Promise.all(readers.map(worker => worker.getResult()))) assertReaderStats(stats, 'refuse');

            const dbf = await DBFFile.open(dbfPath, {readMode: 'loose'});
            expect(dbf.recordCount).equals(N + WORKERS * APPENDS);
            const records = await allRecords(dbf);
            const nonDeleted = records.filter(record => (record as any)[DELETED] !== true).length;
            expect(dbf.recordCount - nonDeleted).equals(expectedDeleted);
            await dbf.close();
        }
        finally {
            await cleanup(dbfPath, cdx, fpt);
        }
    });
});
