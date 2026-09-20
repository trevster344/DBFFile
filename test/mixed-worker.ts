import {DBFFile} from 'dbffile';




/**
 * Forked worker for the multi-client mixed-workload tests. Unlike the focused `lock-worker` /
 * `cdx-worker`, it opens the DBF with configurable CDX/locking options and can run a scripted
 * sequence of reads, appends, updates, deletes and undeletes in a single session. Lock errors are
 * reported (rather than thrown) for reads, so the caller can assert the "consistent or refused"
 * invariant; mutating operations retry `EBUSY` with backoff.
 */




type Step =
    | {kind: 'append', records: Array<Record<string, unknown>>}
    | {kind: 'update', indices: number[], namePrefix: string}
    | {kind: 'delete', indices: number[]}
    | {kind: 'undelete', indices: number[]}
    | {kind: 'reindex'};

interface Payload {
    op: string;
    dbfPath: string;
    cdx?: 0x30 | 0xf5;
    encoding?: string;
    readWaitTimeout?: number;
    indexReadWaitTimeout?: number;
    tag?: string;
    key?: unknown;
    records?: Array<Record<string, unknown>>;
    index?: number;
    field?: string;
    value?: number;
    iterations?: number;
    delayMs?: number;
    maxCount?: number;
    steps?: Step[];
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




function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}




async function open(payload: Payload): Promise<DBFFile> {
    return DBFFile.open(payload.dbfPath, {
        cdx: payload.cdx,
        encoding: payload.encoding,
        locking: true,
        readWaitTimeout: payload.readWaitTimeout,
        indexReadWaitTimeout: payload.indexReadWaitTimeout,
    });
}




function isLockError(err: any): boolean {
    return !!err && (err.code === 'EBUSY' || err.code === 'ETIMEDOUT');
}




async function retry<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; ++attempt) {
        try { return await action(); }
        catch (err: any) {
            if (attempt < 600 && isLockError(err)) { await delay(25); continue; }
            throw err;
        }
    }
}




function checksum(records: Array<Record<string, unknown>>): number {
    let hash = 2166136261;
    for (const record of records) {
        for (const key of Object.keys(record)) {
            const value = record[key];
            const text = value === null || value === undefined ? '' : String(value);
            for (let i = 0; i < text.length; ++i) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
            hash ^= 0x1f; hash = Math.imul(hash, 16777619);
        }
    }
    return hash >>> 0;
}




async function readAll(dbf: DBFFile, includeDeleted = true): Promise<Array<Record<string, unknown>>> {
    dbf._includeDeletedRecords = includeDeleted;
    dbf._recordsRead = 0;
    return dbf.readRecords(Number.MAX_SAFE_INTEGER);
}




// Reads a bounded snapshot and reports it, or a lock refusal. Bounded so a looping reader stays cheap.
async function readDbf(dbf: DBFFile, maxCount: number): Promise<unknown> {
    try {
        dbf._includeDeletedRecords = false;
        dbf._recordsRead = 0;
        const records = await dbf.readRecords(maxCount);
        return {ok: true, count: records.length, checksum: checksum(records), recordCount: dbf.recordCount};
    }
    catch (err: any) {
        if (isLockError(err)) return {ok: false, code: err.code};
        throw err;
    }
}




async function readIndex(dbf: DBFFile, tag: string, maxCount: number): Promise<unknown> {
    try {
        const records = await dbf.readRecords({index: tag, maxCount});
        return {ok: true, count: records.length, checksum: checksum(records)};
    }
    catch (err: any) {
        if (isLockError(err)) return {ok: false, code: err.code};
        throw err;
    }
}




// Builds a full replacement record (all fields) from an existing record, preserving the schema.
function withOverrides(dbf: DBFFile, existing: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = {};
    for (const field of dbf.fields) next[field.name] = existing[field.name];
    return {...next, ...overrides};
}




async function runStep(dbf: DBFFile, step: Step): Promise<void> {
    switch (step.kind) {

        case 'append': {
            await retry(async () => {
                await dbf.lockFile({wait: true, timeoutMs: 60000});
                try { await dbf.appendRecords(step.records); }
                finally { await dbf.unlockFile(); }
            });
            return;
        }

        case 'update': {
            // The initial snapshot read can itself be refused while another process holds the file
            // lock, so it is retried like the writes.
            const all = await retry(() => readAll(dbf, true));
            const hasMemo = dbf.fields.some(f => f.type === 'M');
            for (const index of step.indices) {
                await retry(async () => {
                    await dbf.lockRecord(index, {wait: true, timeoutMs: 60000});
                    try {
                        const overrides: Record<string, unknown> = {NAME: `${step.namePrefix}${String(index).padStart(9, '0')}`};
                        if (hasMemo) overrides.NOTES = `${step.namePrefix}notes-${index}-` + 'x'.repeat(index % 50);
                        await dbf.updateRecord(index, withOverrides(dbf, all[index], overrides));
                    }
                    finally { await dbf.unlockRecord(index); }
                });
            }
            return;
        }

        case 'delete': {
            for (const index of step.indices) {
                await retry(async () => {
                    await dbf.lockRecord(index, {wait: true, timeoutMs: 60000});
                    try { await dbf.deleteRecord(index); }
                    finally { await dbf.unlockRecord(index); }
                });
            }
            return;
        }

        case 'undelete': {
            for (const index of step.indices) {
                await retry(async () => {
                    await dbf.lockRecord(index, {wait: true, timeoutMs: 60000});
                    try { await dbf.undeleteRecord(index); }
                    finally { await dbf.unlockRecord(index); }
                });
            }
            return;
        }

        case 'reindex': {
            await dbf.reindex();
            return;
        }
    }
}




async function perform(payload: Payload): Promise<unknown> {
    const readOps = new Set(['readDbf', 'readIndex', 'readLoop', 'seekKey']);
    let dbf: DBFFile;
    try {
        dbf = await open(payload);
    }
    catch (err: any) {
        // Opening can itself contend on a lock (e.g. opening the index); report it as a refusal.
        if (readOps.has(payload.op) && isLockError(err)) return {ok: false, code: err.code};
        throw err;
    }
    try {
        switch (payload.op) {

            case 'readDbf':
                return await readDbf(dbf, payload.maxCount ?? 500);

            case 'readIndex':
                return await readIndex(dbf, payload.tag!, payload.maxCount ?? 500);

            case 'readLoop': {
                const iterations = payload.iterations ?? 20;
                const delayMs = payload.delayMs ?? 0;
                const maxCount = payload.maxCount ?? 500;
                let ok = 0, refused = 0, maxCountSeen = 0, minCount = Infinity;
                const codes: Record<string, number> = {};
                for (let i = 0; i < iterations; ++i) {
                    const result: any = payload.tag ? await readIndex(dbf, payload.tag, maxCount) : await readDbf(dbf, maxCount);
                    if (result.ok) { ok++; maxCountSeen = Math.max(maxCountSeen, result.count); minCount = Math.min(minCount, result.count); }
                    else { refused++; codes[result.code] = (codes[result.code] ?? 0) + 1; }
                    if (delayMs) await delay(delayMs);
                }
                return {ok, refused, maxCount: maxCountSeen, minCount: minCount === Infinity ? 0 : minCount, codes};
            }

            case 'seekKey': {
                try {
                    const record = await dbf.seek(payload.tag!, payload.key);
                    return {ok: true, found: record !== undefined};
                }
                catch (err: any) {
                    if (isLockError(err)) return {ok: false, code: err.code};
                    throw err;
                }
            }

            case 'append': {
                await retry(async () => {
                    await dbf.lockFile({wait: true, timeoutMs: 60000});
                    try { await dbf.appendRecords(payload.records!); }
                    finally { await dbf.unlockFile(); }
                });
                return {ok: true, recordCount: dbf.recordCount};
            }

            case 'increment': {
                const index = payload.index!;
                const field = payload.field!;
                for (let i = 0; i < (payload.iterations ?? 1); ++i) {
                    await retry(async () => {
                        await dbf.lockRecord(index, {wait: true, timeoutMs: 60000});
                        try {
                            const all = await readAll(dbf, true);
                            const record = all[index];
                            await dbf.updateRecord(index, withOverrides(dbf, record, {[field]: Number(record[field]) + (payload.value ?? 1)}));
                        }
                        finally { await dbf.unlockRecord(index); }
                    });
                }
                return {ok: true};
            }

            case 'reindex': {
                await dbf.reindex();
                return {ok: true, recordCount: dbf.recordCount};
            }

            case 'holdFileLock': {
                await dbf.lockFile();
                send('locked');
                await waitFor('release');
                await dbf.unlockFile();
                return {ok: true};
            }

            case 'holdIndexLock': {
                await dbf.lockIndexFile();
                send('locked');
                await waitFor('release');
                await dbf.unlockIndexFile();
                return {ok: true};
            }

            case 'mixedScript': {
                for (const step of payload.steps ?? []) await runStep(dbf, step);
                return {ok: true, recordCount: dbf.recordCount};
            }

            default:
                throw new Error(`Unknown mixed worker op '${payload.op}'`);
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
