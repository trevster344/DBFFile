import {expect} from 'chai';
import {DBFFile, FieldDescriptor, FileLocker} from 'dbffile';
import {promises as fs} from 'fs';
import * as path from 'path';
import {fork, ChildProcess} from 'child_process';




/**
 * Cross-process locking tests. POSIX `fcntl` locks are per-process and Windows `LockFileEx` locks are
 * per-handle, so every conflict test uses a separate worker process. The historical xBase "read-through"
 * scheme is exercised explicitly: record locks must not block reads, while a whole-file lock must.
 */
describe('Locking', function () {

    this.timeout(60000);

    const fixtures = path.join(__dirname, './fixtures');
    const workerPath = path.join(__dirname, 'lock-worker.js');
    const supported = FileLocker.isSupported();

    function delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function range(n: number): number[] {
        return Array.from({length: n}, (_, i) => i);
    }

    class Worker {
        child: ChildProcess;
        private ready: Promise<void>;
        private result: Promise<any>;
        private exited: Promise<void>;

        constructor(payload: object, timeoutMs = 20000) {
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

    async function createDbf(name: string, fields: FieldDescriptor[], records: Array<Record<string, unknown>>, options?: any): Promise<string> {
        const p = path.join(fixtures, name);
        await fs.unlink(p).catch(() => {});
        const dbf = await DBFFile.create(p, fields, options);
        if (records.length) await dbf.appendRecords(records);
        return p;
    }

    async function cleanup(...paths: string[]): Promise<void> {
        for (const p of paths) await fs.unlink(p).catch(() => {});
    }

    before(function () {
        if (!supported) this.skip();
    });

    it('lock/unlock and fresh probes work on a single process', async () => {
        const dbfPath = await createDbf('locking-basic.dbf', [{name: 'ID', type: 'N', size: 5}], [{ID: 1}]);
        try {
            const dbf = await DBFFile.open(dbfPath, {locking: true});
            expect(await dbf.isFileLocked()).equals(false);
            expect(await dbf.isRecordLocked(0)).equals(false);

            await dbf.lockFile();
            expect(await dbf.isFileLocked()).equals(true);
            await dbf.unlockFile();
            expect(await dbf.isFileLocked()).equals(false);

            await dbf.lockRecord(0);
            expect(await dbf.isRecordLocked(0)).equals(true);
            await dbf.unlockRecord(0);
            expect(await dbf.isRecordLocked(0)).equals(false);

            await dbf.close();
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('prevents lost updates across processes using record locks', async () => {
        const dbfPath = await createDbf('locking-lost-update.dbf',
            [{name: 'ID', type: 'N', size: 5}, {name: 'VAL', type: 'N', size: 10}],
            [{ID: 1, VAL: 0}]);
        try {
            const workers = await Promise.all(range(4).map(() =>
                new Worker({op: 'increment', dbfPath, index: 0, field: 'VAL', iterations: 10, value: 1}).start()));
            await Promise.all(workers.map(w => w.getResult()));

            const dbf = await DBFFile.open(dbfPath);
            const records = await dbf.readRecords(10);
            expect(records[0].VAL, 'every increment must be preserved').equals(40);
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('detects a foreign record lock, but allows read-through', async () => {
        const dbfPath = await createDbf('locking-readthrough.dbf',
            [{name: 'ID', type: 'N', size: 5}, {name: 'VAL', type: 'N', size: 10}],
            [{ID: 1, VAL: 7}]);
        try {
            const dbf = await DBFFile.open(dbfPath, {locking: true});
            await dbf.lockRecord(0);
            expect(await dbf.isRecordLocked(0)).equals(true);

            // Another process cannot acquire the same record lock...
            const contender = await new Worker({op: 'tryLock', dbfPath, index: 0}).start();
            const contended = await contender.getResult();
            expect(contended.acquired).equals(false);
            expect(contended.code).equals('EBUSY');

            // ...but it can still read the record (read-through).
            const reader = await new Worker({op: 'read', dbfPath}).start();
            const read = await reader.getResult();
            expect(read.ok).equals(true);
            expect(read.first.VAL).equals(7);

            // Once released, the record can be locked by the other process.
            await dbf.unlockRecord(0);
            await dbf.close();
            const freed = await new Worker({op: 'tryLock', dbfPath, index: 0}).start();
            expect((await freed.getResult()).acquired).equals(true);
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('refuses lock-aware reads while another process holds the file lock', async () => {
        const dbfPath = await createDbf('locking-filelock.dbf',
            [{name: 'ID', type: 'N', size: 5}],
            [{ID: 1}]);
        try {
            const dbf = await DBFFile.open(dbfPath, {locking: true});
            await dbf.lockFile();

            const reader = await new Worker({op: 'read', dbfPath}).start();
            let error: any;
            try { await reader.getResult(); } catch (err) { error = err; }
            expect(error, 'a lock-aware read must be refused while the file is locked').to.be.instanceOf(Error);
            expect(error.message).contains('locked');

            await dbf.unlockFile();
            await dbf.close();

            const after = await new Worker({op: 'read', dbfPath}).start();
            expect((await after.getResult()).ok).equals(true);
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('requires an explicit lock before writing when locking is enabled', async () => {
        const dbfPath = await createDbf('locking-enforce.dbf',
            [{name: 'ID', type: 'N', size: 5}, {name: 'VAL', type: 'N', size: 10}],
            [{ID: 1, VAL: 0}]);
        try {
            const worker = await new Worker({op: 'updateWithoutLock', dbfPath, index: 0, field: 'VAL', value: 99}).start();
            const result = await worker.getResult();
            expect(result.error).equals(true);
            expect(result.code).equals('ENOLOCK');
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('waits for a record lock held by another process, then proceeds', async () => {
        const dbfPath = await createDbf('locking-wait.dbf',
            [{name: 'ID', type: 'N', size: 5}],
            [{ID: 1}]);
        try {
            const dbf = await DBFFile.open(dbfPath, {locking: true});
            await dbf.lockRecord(0);

            const waiter = new Worker({op: 'lockWait', dbfPath, index: 0, timeoutMs: 15000});
            await waiter.start();
            let acquired = false;
            waiter.waitForMessage('acquired').then(() => { acquired = true; });

            await delay(400);
            expect(acquired, 'the waiter must not acquire the lock while it is held').equals(false);

            await dbf.unlockRecord(0);
            await waiter.waitForMessage('acquired');
            waiter.send('release');
            expect((await waiter.getResult()).acquired).equals(true);
            await dbf.close();
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('releases locks when the holding process dies', async () => {
        const dbfPath = await createDbf('locking-crash.dbf',
            [{name: 'ID', type: 'N', size: 5}],
            [{ID: 1}]);
        try {
            const holder = new Worker({op: 'holdLock', dbfPath, index: 0});
            await holder.start();
            await holder.waitForMessage('locked');
            holder.kill();
            await holder.waitForExit();

            // The OS must have released the dead process's lock.
            const dbf = await DBFFile.open(dbfPath, {locking: true});
            await dbf.lockRecord(0);
            await dbf.unlockRecord(0);
            await dbf.close();
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('serializes concurrent appends from multiple processes with the file lock', async () => {
        const dbfPath = await createDbf('locking-append.dbf',
            [{name: 'ID', type: 'N', size: 5}],
            []);
        try {
            const workers = await Promise.all(range(5).map(i =>
                new Worker({op: 'appendWithFileLock', dbfPath, records: [{ID: i}]}).start()));
            await Promise.all(workers.map(w => w.getResult()));

            const dbf = await DBFFile.open(dbfPath);
            expect(dbf.recordCount).equals(5);
            const records = await dbf.readRecords(10);
            expect(records.map(r => r.ID).sort()).deep.equals([0, 1, 2, 3, 4]);
        }
        finally {
            await cleanup(dbfPath);
        }
    });

    it('serializes concurrent memo appends from multiple processes', async () => {
        const dbfPath = await createDbf('locking-memo.dbf',
            [{name: 'ID', type: 'N', size: 5}, {name: 'NOTES', type: 'M', size: 4}],
            [],
            {fileVersion: 0x30});
        const memoPath = dbfPath.slice(0, -4) + '.fpt';
        try {
            const workers = await Promise.all(range(4).map(i =>
                new Worker({op: 'appendWithFileLock', dbfPath, records: [{ID: i, NOTES: `memo-${i}-` + 'x'.repeat(i * 200)}]}).start()));
            await Promise.all(workers.map(w => w.getResult()));

            const dbf = await DBFFile.open(dbfPath);
            expect(dbf.recordCount).equals(4);
            const records = await dbf.readRecords(10);
            for (const i of range(4)) {
                const record = records.find(r => r.ID === i)!;
                expect(record.NOTES, `memo ${i} must round-trip`).equals(`memo-${i}-` + 'x'.repeat(i * 200));
            }
        }
        finally {
            await cleanup(dbfPath, memoPath);
        }
    });
});
