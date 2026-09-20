import {DBFFile} from 'dbffile';




/**
 * Worker process used by the locking tests to exercise cross-process byte-range locks. It is spawned
 * with `child_process.fork` and a JSON payload as its first argument. It reports readiness, waits for a
 * 'go' message (so that all workers contend at the same moment), performs a single operation, and
 * reports the result back over IPC. It is a no-op when loaded by mocha rather than forked.
 */




interface Payload {
    op: string;
    dbfPath: string;
    index?: number;
    field?: string;
    value?: number;
    iterations?: number;
    records?: Array<Record<string, unknown>>;
    wait?: boolean;
    timeoutMs?: number;
    readWaitTimeout?: number;
    indexReadWaitTimeout?: number;
}




function send(message: unknown): void {
    if (process.send) process.send(message);
}




function waitFor(message: string): Promise<void> {
    return new Promise(resolve => {
        process.on('message', (msg: unknown) => {
            if (msg === message) resolve();
        });
    });
}




async function readAll(dbf: DBFFile): Promise<Array<Record<string, unknown>>> {
    dbf._recordsRead = 0;
    return dbf.readRecords(1000000);
}




async function perform(payload: Payload): Promise<unknown> {
    const dbf = await DBFFile.open(payload.dbfPath, {
        locking: true,
        readWaitTimeout: payload.readWaitTimeout,
        indexReadWaitTimeout: payload.indexReadWaitTimeout,
    });
    try {
        switch (payload.op) {

            case 'increment': {
                const index = payload.index!;
                const field = payload.field!;
                for (let i = 0; i < (payload.iterations ?? 1); ++i) {
                    await dbf.lockRecord(index, {wait: true, timeoutMs: 30000});
                    try {
                        const record = (await readAll(dbf))[index];
                        await dbf.updateRecord(index, {...record, [field]: Number(record[field]) + (payload.value ?? 1)});
                    }
                    finally {
                        await dbf.unlockRecord(index);
                    }
                }
                return {ok: true};
            }

            case 'tryLock': {
                const index = payload.index!;
                try {
                    await dbf.lockRecord(index, {wait: false});
                }
                catch (err: any) {
                    return {acquired: false, code: err.code};
                }
                await dbf.unlockRecord(index);
                return {acquired: true};
            }

            case 'lockWait': {
                const index = payload.index!;
                try {
                    await dbf.lockRecord(index, {wait: true, timeoutMs: payload.timeoutMs ?? 5000});
                }
                catch (err: any) {
                    return {acquired: false, code: err.code};
                }
                send('acquired');
                await waitFor('release');
                await dbf.unlockRecord(index);
                return {acquired: true};
            }

            case 'holdLock': {
                const index = payload.index!;
                await dbf.lockRecord(index);
                send('locked');
                await waitFor('release');
                await dbf.unlockRecord(index);
                return {ok: true};
            }

            case 'lockFileHold': {
                await dbf.lockFile();
                send('locked');
                await waitFor('release');
                await dbf.unlockFile();
                return {ok: true};
            }

            case 'read': {
                const records = await readAll(dbf);
                return {ok: true, recordCount: records.length, first: records[0]};
            }

            case 'updateWithoutLock': {
                const index = payload.index!;
                try {
                    const record = (await readAll(dbf))[index];
                    await dbf.updateRecord(index, {...record, [payload.field!]: payload.value});
                }
                catch (err: any) {
                    return {error: true, code: err.code, message: err.message};
                }
                return {error: false};
            }

            case 'appendWithFileLock': {
                await dbf.lockFile({wait: true, timeoutMs: 10000});
                try {
                    await dbf.appendRecords(payload.records!);
                }
                finally {
                    await dbf.unlockFile();
                }
                return {ok: true};
            }

            default:
                throw new Error(`Unknown worker op '${payload.op}'`);
        }
    }
    finally {
        await dbf.close();
    }
}




async function main(): Promise<void> {
    const payload = JSON.parse(process.argv[2]) as Payload;
    send({type: 'ready', pid: process.pid});
    await waitFor('go');
    try {
        const result = await perform(payload);
        send({type: 'result', result});
        process.exit(0);
    }
    catch (err: any) {
        send({type: 'error', message: err.message, code: err.code});
        process.exit(1);
    }
}




if (require.main === module) {
    main().catch(err => {
        send({type: 'error', message: err.message, code: err.code});
        process.exit(1);
    });
}
