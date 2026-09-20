import {fork, ChildProcess} from 'child_process';




/**
 * A forked worker process used by the multi-client tests. It is spawned with a JSON payload as its
 * first argument, reports readiness, waits for a `go` message (so all workers contend at the same
 * moment), performs its operation and reports the result over IPC.
 */
export class Worker {
    child: ChildProcess;
    private ready: Promise<void>;
    private result: Promise<any>;
    private exited: Promise<void>;

    constructor(workerPath: string, payload: object, timeoutMs = 120000) {
        this.child = fork(workerPath, [JSON.stringify(payload)], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
        this.ready = new Promise(resolve => {
            this.child.on('message', (message: any) => { if (message && message.type === 'ready') resolve(); });
        });
        this.exited = new Promise(resolve => { this.child.on('exit', () => resolve()); });
        this.result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.child.kill(); reject(new Error('worker timed out')); }, timeoutMs);
            this.child.on('message', (message: any) => {
                if (message && message.type === 'result') { clearTimeout(timer); resolve(message.result); }
                if (message && message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
            });
            this.child.on('exit', code => {
                if (code !== 0) { clearTimeout(timer); reject(new Error(`worker exited with code ${code}`)); }
            });
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
            const handler = (message: any) => { if (message === text) { this.child.off('message', handler); resolve(); } };
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
