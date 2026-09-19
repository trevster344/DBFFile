import {expect} from 'chai';
import {CdxExpression, collationForName, DBFFile, DELETED, encodeCdxKey, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';
import {fork} from 'child_process';
import {contextFor, validateIndexIntegrity} from './cdx-helpers';




/**
 * Large-scale concurrency stress test: many clients append batches, delete records and edit records
 * in the middle of a big table at the same time. The invariant checked at the end is not any
 * particular interleaving, but that the final index is a complete, correct reflection of the final
 * DBF (coverage, ordering, and every stored key equal to the expression evaluated on the record).
 *
 * Scale is configurable: `CDX_STRESS_N` (seed records, default 100000), `CDX_STRESS_WORKERS`
 * (default 4) and `CDX_STRESS_APPENDS` (per worker, default 5000). To run at "hundreds of
 * thousands", e.g. `CDX_STRESS_N=300000 npm test`.
 */
describe('CDX large-scale concurrent stress', function () {

    this.timeout(600000);

    const dir = path.join(__dirname, './fixtures');
    const workerPath = path.join(__dirname, 'cdx-worker.js');
    const fields: FieldDescriptor[] = [
        {name: 'ID', type: 'I', size: 4},
        {name: 'NAME', type: 'C', size: 20},
    ];

    const N = Number(process.env.CDX_STRESS_N ?? 100000);
    const WORKERS = Number(process.env.CDX_STRESS_WORKERS ?? 4);
    const APPENDS = Number(process.env.CDX_STRESS_APPENDS ?? 5000);
    const MUTATIONS = Math.min(1500, Math.max(1, Math.floor(N / (WORKERS * 20))));

    function runWorker(payload: object): Promise<any> {
        return new Promise((resolve, reject) => {
            const child = fork(workerPath, [JSON.stringify(payload)], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
            const timer = setTimeout(() => { child.kill(); reject(new Error('stress worker timed out')); }, 600000);
            child.on('message', (message: any) => {
                if (message && message.type === 'ready') child.send('go');
                if (message && message.type === 'result') { clearTimeout(timer); resolve(message.result); }
                if (message && message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
            });
            child.on('exit', code => {
                if (code !== 0) { clearTimeout(timer); reject(new Error(`stress worker exited with code ${code}`)); }
            });
        });
    }

    async function readAll(dbf: DBFFile): Promise<Array<Record<string, unknown>>> {
        const savedRaw = dbf._rawCharacterFields, savedInclude = dbf._includeDeletedRecords;
        dbf._rawCharacterFields = true;
        dbf._includeDeletedRecords = true;
        dbf._recordsRead = 0;
        try { return await dbf.readRecords(Number.MAX_SAFE_INTEGER); }
        finally { dbf._rawCharacterFields = savedRaw; dbf._includeDeletedRecords = savedInclude; }
    }

    it('stays consistent while appending, deleting and editing mid-file concurrently', async () => {
        const dbfPath = path.join(dir, 'stress-mixed.dbf');
        const cdxPath = path.join(dir, 'stress-mixed.cdx');
        for (const p of [dbfPath, cdxPath]) await fs.unlink(p).catch(() => {});
        try {
            // Seed N records (one reindex at the end).
            const dbf = await DBFFile.create(dbfPath, fields, {fileVersion: 0x30, indexes: [{tag: 'NAME', expression: 'NAME'}]});
            const batch = 50000;
            for (let start = 0; start < N; start += batch) {
                const records = [];
                for (let i = start; i < Math.min(start + batch, N); ++i) records.push({ID: i, NAME: 'n' + String(i).padStart(9, '0')});
                await dbf.appendRecords(records);
            }
            await dbf.close();

            // Partition the seed into disjoint per-worker ranges so record mutations never overlap.
            const chunk = Math.floor(N / WORKERS);
            const payloads: object[] = [];
            let totalDeletes = 0, totalUpdates = 0, totalAppends = 0;
            for (let w = 0; w < WORKERS; ++w) {
                payloads.push({
                    op: 'stressMutate',
                    dbfPath,
                    rangeStart: w * chunk,
                    rangeChunk: chunk,
                    mutations: MUTATIONS,
                    updatePrefix: `u${w}-`,
                    appendCount: APPENDS,
                    appendIdBase: N + w * APPENDS,
                    appendPrefix: `a${w}-`,
                });
                totalDeletes += MUTATIONS;
                totalUpdates += MUTATIONS;
                totalAppends += APPENDS;
            }

            // Fire all clients at once.
            const results = await Promise.all(payloads.map(runWorker));
            expect(results.length).equals(WORKERS);

            // The final index must be a complete, correct reflection of the final DBF.
            const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
            expect(reopened.recordCount, 'final record count').equals(N + totalAppends);
            const records = await readAll(reopened);
            expect(records.length, 'records readable').equals(N + totalAppends);
            const nonDeleted = records.filter(record => (record as any)[DELETED] !== true).length;
            expect(reopened.recordCount - nonDeleted, 'deleted records').equals(totalDeletes);
            expect(totalUpdates).to.be.greaterThan(0);

            const tag = reopened.tags[0];
            const integrity = validateIndexIntegrity(reopened, tag, false);
            expect(integrity.recnos.size, 'index coverage of live records').equals(nonDeleted);

            // Every stored key must equal the expression evaluated on the (padded) record.
            const expression = CdxExpression.parse(tag.keyExpression);
            const collation = collationForName(tag.collation);
            const pad = tag.keyType === 'C' ? 0x20 : 0x00;
            const logical = (key: Buffer) => {
                let end = key.length;
                while (end > 0 && key[end - 1] === pad) --end;
                return key.subarray(0, end);
            };
            for (const entry of integrity.entries) {
                const expected = encodeCdxKey(expression.evaluate(contextFor(records[entry.recno - 1])), tag.keyType, tag.keyLength, collation, reopened._encoding as string);
                expect(Buffer.compare(logical(expected), logical(entry.key)), `key for recno ${entry.recno}`).equals(0);
            }
            await reopened.close();
        }
        finally {
            for (const p of [dbfPath, cdxPath]) await fs.unlink(p).catch(() => {});
        }
    });
});
