import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { WagerCommand, WagerResult } from '../../src/application/wager-contracts.js';

type WireReply =
  | { readonly action: 'ready' }
  | { readonly id: string; readonly ok: true; readonly result: WagerResult | null }
  | { readonly id: string; readonly ok: false; readonly message: string; readonly code?: string };

export class WagerChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, {
    readonly resolve: (result: WagerResult | null) => void;
    readonly reject: (error: Error) => void;
  }>();
  private readonly startup: Promise<void>;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private stderr = '';

  private constructor() {
    this.startup = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.child = spawn(process.execPath, ['test/support/concurrency-child.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (data: Buffer) => { this.stderr += data.toString(); });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const reply = JSON.parse(line) as WireReply;
      if ('action' in reply) {
        this.readyResolve?.();
        return;
      }
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      if (reply.ok) waiting.resolve(reply.result);
      else waiting.reject(new Error(`${reply.code ?? 'WORKER_ERROR'}: ${reply.message}`));
    });
    this.child.on('error', (error: Error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error(
      `Bun child exited with code ${code}: ${this.stderr}`,
    )));
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }

  static async start(): Promise<WagerChild> {
    const worker = new WagerChild();
    await worker.startup;
    return worker;
  }

  private send(payload: Record<string, unknown>): Promise<WagerResult | null> {
    const id = randomUUID();
    return new Promise<WagerResult | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  async process(command: WagerCommand): Promise<WagerResult> {
    const result = await this.send({ action: 'process', command });
    if (!result) throw new Error('Missing process result');
    return result;
  }

  retry(transactionId: string, walletId: string): Promise<WagerResult | null> {
    return this.send({ action: 'retry', transactionId, walletId });
  }

  async stop(): Promise<void> {
    const exited = new Promise<number | null>(resolve => {
      this.child.once('exit', resolve);
    });
    this.child.stdin.end();
    const exitCode = await exited;
    if (exitCode !== 0) throw new Error(`Bun child exited: ${exitCode}; ${this.stderr}`);
  }
}
