import {DBFFile} from 'dbffile';




/**
 * Worker process for the CDX concurrency tests. Forked with a JSON payload, it reports readiness,
 * waits for a 'go' message (so all workers contend at the same moment), performs one CDX operation
 * and reports the result. It is a no-op when loaded by mocha rather than forked.
 */




interface Payload {
    op: string;
    dbfPath: string;
    tag?: string;
    index?: number;
    field?: string;
    value?: unknown;
    records?: Array<Record<string, unknown>>;
    maxCount?: number;
    timeoutMs?: number;
    rangeStart?: number;
    rangeChunk?: number;
    mutations?: number;
    updatePrefix?: string;
    appendCount?: number;
    appendIdBase?: number;
    appendPrefix?: string;
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




async function open(dbfPath: string): Promise<DBFFile> {
    return DBFFile.open(dbfPath, {cdx: 0x30, locking: true});
}




async function perform(payload: Payload): Promise<unknown> {
    switch (payload.op) {

        case 'appendWithIndex': {
            const dbf = await open(payload.dbfPath);
            try {
                await dbf.lockFile({wait: true, timeoutMs: 30000});
                try {
                    await dbf.appendRecords(payload.records!);
                }
                finally {
                    await dbf.unlockFile();
                }
                return {ok: true, recordCount: dbf.recordCount};
            }
            finally {
                await dbf.close(); // rebuilds the index after the file lock is released
            }
        }

        case 'reindexIndex': {
            const dbf = await open(payload.dbfPath);
            try {
                await dbf.reindex();
                return {ok: true, recordCount: dbf.recordCount};
            }
            finally {
                await dbf.close();
            }
        }

        case 'updateWithIndex': {
            const dbf = await open(payload.dbfPath);
            try {
                const index = payload.index!;
                await dbf.lockRecord(index, {wait: true, timeoutMs: 30000});
                try {
                    dbf._recordsRead = 0;
                    const record = (await dbf.readRecords(index + 1))[index];
                    await dbf.updateRecord(index, {...record, [payload.field!]: payload.value});
                }
                finally {
                    await dbf.unlockRecord(index);
                }
                return {ok: true};
            }
            finally {
                await dbf.close();
            }
        }

        case 'stressMutate': {
            const dbf = await open(payload.dbfPath);
            // Concurrent appends briefly hold the exclusive DBF file lock, which makes record writes
            // report EBUSY; retry rather than fail so the stress test exercises real contention.
            const retry = async (action: () => Promise<unknown>): Promise<unknown> => {
                for (let attempt = 0; ; ++attempt) {
                    try { return await action(); }
                    catch (err: any) {
                        if (attempt < 400 && (err.code === 'EBUSY' || /locked by another process/i.test(err.message))) {
                            await new Promise(resolve => setTimeout(resolve, 25));
                            continue;
                        }
                        throw err;
                    }
                }
            };
            const start = payload.rangeStart ?? 0;
            const chunk = payload.rangeChunk ?? 0;
            const mutations = payload.mutations ?? 0;
            const step = Math.max(2, Math.floor(chunk / Math.max(1, mutations)));
            try {
                for (let k = 0; k < mutations; ++k) {
                    const index = start + k * step;
                    await retry(async () => {
                        await dbf.lockRecord(index, {wait: true, timeoutMs: 120000});
                        try { await dbf.deleteRecord(index); }
                        finally { await dbf.unlockRecord(index); }
                    });
                }
                for (let k = 0; k < mutations; ++k) {
                    const index = start + 1 + k * step;
                    await retry(async () => {
                        await dbf.lockRecord(index, {wait: true, timeoutMs: 120000});
                        try { await dbf.updateRecord(index, {ID: index, NAME: `${payload.updatePrefix}${String(index).padStart(9, '0')}`}); }
                        finally { await dbf.unlockRecord(index); }
                    });
                }
                const count = payload.appendCount ?? 0;
                if (count > 0) {
                    const records: Array<Record<string, unknown>> = [];
                    for (let j = 0; j < count; ++j) records.push({ID: (payload.appendIdBase ?? 0) + j, NAME: `${payload.appendPrefix}${String(j).padStart(8, '0')}`});
                    await retry(async () => {
                        await dbf.lockFile({wait: true, timeoutMs: 120000});
                        try { await dbf.appendRecords(records); }
                        finally { await dbf.unlockFile(); }
                    });
                }
                return {ok: true, recordCount: dbf.recordCount};
            }
            finally {
                await dbf.close();
            }
        }

        case 'readOrdered': {
            const dbf = await open(payload.dbfPath);
            try {
                const records = await dbf.readRecords({index: payload.tag!, maxCount: payload.maxCount ?? 10000000});
                return {ok: true, count: records.length};
            }
            catch (err: any) {
                return {ok: false, code: err.code, message: err.message};
            }
            finally {
                await dbf.close();
            }
        }
        case 'holdIndexLock': {
            const dbf = await open(payload.dbfPath);
            await dbf.lockIndexFile();
            send('locked');
            await waitFor('release');
            await dbf.unlockIndexFile();
            await dbf.close();
            return {ok: true};
        }

        case 'holdFileLock': {
            const dbf = await open(payload.dbfPath);
            await dbf.lockFile();
            send('locked');
            await waitFor('release');
            await dbf.unlockFile();
            await dbf.close();
            return {ok: true};
        }

        default:
            throw new Error(`Unknown CDX worker op '${payload.op}'`);
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
