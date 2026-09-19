import {expect} from 'chai';
import {DBFFile, FieldDescriptor} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';
import {fork, ChildProcess} from 'child_process';
import {validateIndexIntegrity} from './cdx-helpers';




/**
 * Multi-client CDX concurrency tests. POSIX locks are per-process and Windows locks are per-handle,
 * so every scenario uses separate worker processes. Each worker opens the DBF with `{cdx, locking}`.
 */
describe('CDX multi-client concurrency', function () {

    this.timeout(120000);

    const dir = path.join(__dirname, './fixtures');
    const workerPath = path.join(__dirname, 'cdx-worker.js');
    const fields: FieldDescriptor[] = [
        {name: 'ID', type: 'I', size: 4},
        {name: 'NAME', type: 'C', size: 20},
    ];

    function range(n: number): number[] {
        return Array.from({length: n}, (_, i) => i);
    }

    function delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    class Worker {
        child: ChildProcess;
        private ready: Promise<void>;
        private result: Promise<any>;
        private exited: Promise<void>;

        constructor(payload: object, timeoutMs = 60000) {
            this.child = fork(workerPath, [JSON.stringify(payload)], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
            this.ready = new Promise(resolve => {
                this.child.on('message', (m: any) => { if (m && m.type === 'ready') resolve(); });
            });
            this.exited = new Promise(resolve => { this.child.on('exit', () => resolve()); });
            this.result = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { this.child.kill(); reject(new Error('worker timed out')); }, timeoutMs);
                this.child.on('message', (m: any) => {
                    if (m && m.type === 'result') { clearTimeout(timer); resolve(m.result); }
                    if (m && m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
                });
                this.child.on('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`worker exited with code ${code}`)); } });
            });
        }

        async start(): Promise<this> {
            await this.ready;
            this.child.send('go');
            return this;
        }

        getResult(): Promise<any> {
            return this.result;
        }

        waitForMessage(text: string): Promise<void> {
            return new Promise(resolve => {
                const handler = (m: any) => { if (m === text) { this.child.off('message', handler); resolve(); } };
                this.child.on('message', handler);
            });
        }

        send(message: string): void {
            this.child.send(message);
        }

        async waitForExit(): Promise<void> {
            await this.exited;
        }

        kill(): void {
            this.child.kill();
        }
    }

    const created: string[] = [];

    async function createIndexedDbf(name: string, seed: Array<Record<string, unknown>>): Promise<string> {
        const dbfPath = path.join(dir, name + '.dbf');
        const cdxPath = path.join(dir, name + '.cdx');
        for (const p of [dbfPath, cdxPath]) await fs.unlink(p).catch(() => {});
        created.push(dbfPath, cdxPath);
        const dbf = await DBFFile.create(dbfPath, fields, {
            fileVersion: 0x30,
            indexes: [{tag: 'NAME', expression: 'NAME'}],
        });
        if (seed.length) await dbf.appendRecords(seed);
        await dbf.close();
        return dbfPath;
    }

    afterEach(async () => {
        while (created.length) await fs.unlink(created.pop()!).catch(() => {});
    });

    it('serializes concurrent appends with index maintenance', async () => {
        const dbfPath = await createIndexedDbf('conc-append', [{ID: 0, NAME: 'seed'}]);
        const workers = await Promise.all(range(4).map(i => new Worker({
            op: 'appendWithIndex',
            dbfPath,
            records: range(5).map(j => ({ID: i * 5 + j + 1, NAME: `w${i}-${j}-${'x'.repeat(6)}`})),
        }).start()));
        await Promise.all(workers.map(w => w.getResult()));

        const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
        expect(reopened.recordCount).equals(1 + 4 * 5);
        const ordered = await reopened.readRecords({index: 'NAME'});
        expect(ordered.length).equals(reopened.recordCount);
        validateIndexIntegrity(reopened, reopened.tags[0], true);
        await reopened.close();
    });

    it('serializes concurrent reindexing of the same file', async () => {
        const dbfPath = await createIndexedDbf('conc-reindex', range(40).map(i => ({ID: i, NAME: 'n' + String(i).padStart(3, '0')})));
        const workers = await Promise.all(range(4).map(() => new Worker({op: 'reindexIndex', dbfPath}).start()));
        await Promise.all(workers.map(w => w.getResult()));

        const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
        expect(reopened.recordCount).equals(40);
        validateIndexIntegrity(reopened, reopened.tags[0], true);
        await reopened.close();
    });

    it('applies concurrent updates to distinct records and reindexes them all', async () => {
        const dbfPath = await createIndexedDbf('conc-update', range(8).map(i => ({ID: i, NAME: 'old' + String(i).padStart(3, '0')})));
        const workers = await Promise.all(range(8).map(i => new Worker({
            op: 'updateWithIndex',
            dbfPath,
            index: i,
            field: 'NAME',
            value: 'new' + String(i).padStart(3, '0'),
        }).start()));
        await Promise.all(workers.map(w => w.getResult()));

        const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
        const records = await reopened.readRecords(100);
        for (const i of range(8)) expect(records[i].NAME).equals('new' + String(i).padStart(3, '0'));
        const ordered = await reopened.readRecords({index: 'NAME'});
        expect(ordered.length).equals(8);
        validateIndexIntegrity(reopened, reopened.tags[0], true);
        await reopened.close();
    });

    it('never corrupts the index when a reader races a writer holding the file lock', async () => {
        const dbfPath = await createIndexedDbf('conc-readwrite', range(5).map(i => ({ID: i, NAME: 'r' + i})));

        const holder = new Worker({op: 'holdFileLock', dbfPath});
        await holder.start();
        await holder.waitForMessage('locked');

        const reader = await new Worker({op: 'readOrdered', dbfPath, tag: 'NAME'}).start();
        const result = await reader.getResult();
        // A lock-aware read may be refused (EBUSY) while the file is locked, but must never be corrupt.
        expect(result.ok === true || result.code === 'EBUSY', `unexpected result ${JSON.stringify(result)}`).equals(true);

        holder.send('release');
        await holder.getResult();

        const after = await new Worker({op: 'readOrdered', dbfPath, tag: 'NAME'}).start();
        expect((await after.getResult()).ok).equals(true);
    });

    it('leaves the index intact when a process is killed during reindex', async () => {
        const dbfPath = await createIndexedDbf('conc-crash', range(10).map(i => ({ID: i, NAME: 'c' + i})));

        const worker = new Worker({op: 'reindexIndex', dbfPath});
        await worker.start();
        await delay(5);
        worker.kill();
        await worker.waitForExit();

        // Whether the reindex completed or not, the index must still be a complete, readable file.
        const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
        expect(reopened.recordCount).equals(10);
        validateIndexIntegrity(reopened, reopened.tags[0], true);
        await reopened.close();
    });

    it('stays consistent under mixed concurrent appends and reads', async () => {
        const dbfPath = await createIndexedDbf('conc-stress', [{ID: 0, NAME: 'seed'}]);

        const appenders = range(3).map(i => new Worker({
            op: 'appendWithIndex',
            dbfPath,
            records: range(3).map(j => ({ID: 100 + i * 3 + j, NAME: `s${i}-${j}-${'y'.repeat(6)}`})),
        }));
        const readers = range(2).map(() => new Worker({op: 'readOrdered', dbfPath, tag: 'NAME'}));

        await Promise.all([...appenders, ...readers].map(w => w.start()));
        const settled = await Promise.all([...appenders, ...readers].map(w => w.getResult().then(
            value => ({status: 'fulfilled' as const, value}),
            reason => ({status: 'rejected' as const, reason}),
        )));
        // Appenders must all succeed; readers may be refused while a writer holds the file lock.
        for (let i = 0; i < appenders.length; ++i) expect(settled[i].status, `appender ${i}`).equals('fulfilled');

        const reopened = await DBFFile.open(dbfPath, {cdx: 0x30});
        expect(reopened.recordCount).equals(1 + 3 * 3);
        const ordered = await reopened.readRecords({index: 'NAME'});
        expect(ordered.length).equals(reopened.recordCount);
        validateIndexIntegrity(reopened, reopened.tags[0], true);
        await reopened.close();
    });
});
