import { Worker } from 'node:worker_threads';
import type { VectorIndex, VectorSummary } from '@cavemem/core';
import type { ScanRequest, ScanResponse, ScanThreadData } from './scan-thread.js';

export interface ScanClientOptions {
  dbPath: string;
  model: string;
  dim: number;
  timeoutMs?: number;
  /** Bounds the initial corpus load; a hung load must fail, not hang searches. */
  loadTimeoutMs?: number;
  entry?: URL;
  /** Tests only. */
  execArgv?: string[];
  log?: (line: Record<string, unknown>) => void;
  /** Tests only: forwarded in workerData; the thread sleeps this long per request. */
  testDelayMs?: number;
  /** Tests only: forwarded in workerData; the thread blocks this long before loading. */
  testLoadDelayMs?: number;
}

interface Pending {
  qvec: Float32Array;
  keywordIds: number[];
  k: number;
  warmup: boolean;
  /** Start of the wait behind another search; null when it never had to wait. */
  queuedSince: number | null;
  resolve: (summary: VectorSummary) => void;
  reject: (err: Error) => void;
}

interface InFlight {
  reqId: number;
  req: Pending;
  queuedMs: number;
  timer: NodeJS.Timeout;
}

const stderrLog = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

/**
 * Runs hybrid-search vector scans on a dedicated thread so a large corpus never
 * blocks the worker's event loop. One request is in flight at a time; the rest
 * wait in a client-side FIFO, which is what `queuedMs` measures. A failure of
 * any kind rejects everything pending and drops the thread; the next call
 * respawns it. There is deliberately no fallback to a degraded result.
 */
export class ScanClient implements VectorIndex {
  private readonly timeoutMs: number;
  private readonly loadTimeoutMs: number;
  private loadTimer: NodeJS.Timeout | undefined;
  private readonly entry: URL;
  private readonly log: (line: Record<string, unknown>) => void;
  private worker: Worker | undefined;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private inflight: InFlight | undefined;
  private queue: Pending[] = [];

  constructor(private readonly opts: ScanClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 60_000;
    this.entry = opts.entry ?? new URL('./scan-thread.js', import.meta.url);
    this.log = opts.log ?? stderrLog;
  }

  /** @internal tests only */
  get thread(): Worker | undefined {
    return this.worker;
  }

  start(): void {
    if (this.worker || this.closed) return;
    const data: ScanThreadData = {
      dbPath: this.opts.dbPath,
      model: this.opts.model,
      dim: this.opts.dim,
      ...(this.opts.testDelayMs !== undefined ? { testDelayMs: this.opts.testDelayMs } : {}),
      ...(this.opts.testLoadDelayMs !== undefined
        ? { testLoadDelayMs: this.opts.testLoadDelayMs }
        : {}),
    };
    const worker = new Worker(this.entry, {
      workerData: data,
      ...(this.opts.execArgv ? { execArgv: this.opts.execArgv } : {}),
    });
    this.worker = worker;
    this.ready = false;
    this.loadTimer = setTimeout(() => {
      this.fail(new Error(`scan thread load timed out after ${this.loadTimeoutMs} ms`), {
        event: 'scan-thread-load-timeout',
        ms: this.loadTimeoutMs,
      });
    }, this.loadTimeoutMs);
    worker.on('message', (msg: ScanResponse) => {
      if (this.worker === worker) this.onMessage(msg);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.fail(new Error(`scan thread error: ${err.message}`), {
        event: 'scan-thread-exit',
        reason: 'error',
        message: err.message,
      });
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.fail(new Error(`scan thread exited (code ${code})`), {
        event: 'scan-thread-exit',
        reason: 'exit',
        code,
      });
    });
  }

  summarize(qvec: Float32Array, keywordIds: number[], k: number): Promise<VectorSummary> {
    if (this.closed) return Promise.reject(new Error('scan thread closed'));
    this.start();
    return new Promise<VectorSummary>((resolve, reject) => {
      this.queue.push({
        // Copy: a view onto a larger buffer would clone the whole buffer.
        qvec: new Float32Array(qvec),
        keywordIds,
        k,
        warmup: !this.ready,
        queuedSince:
          this.ready && !this.inflight && this.queue.length === 0 ? null : performance.now(),
        resolve,
        reject,
      });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.fail(new Error('scan thread closed'), undefined);
  }

  private onMessage(msg: ScanResponse): void {
    if (msg.type === 'ready') {
      clearTimeout(this.loadTimer);
      this.ready = true;
      // Waiting for the corpus to load is warmup, not queueing behind a search.
      const now = performance.now();
      this.queue.forEach((p, i) => {
        p.queuedSince = i === 0 ? null : now;
      });
      this.pump();
      return;
    }
    if (msg.type === 'error') {
      this.fail(new Error(`scan thread error: ${msg.message}`), {
        event: 'scan-thread-exit',
        reason: 'error',
        reqId: msg.reqId,
        message: msg.message,
      });
      return;
    }
    const flight = this.inflight;
    if (!flight || flight.reqId !== msg.reqId) return;
    clearTimeout(flight.timer);
    this.inflight = undefined;
    flight.req.resolve({
      ...msg.summary,
      queuedMs: flight.queuedMs,
      warmup: flight.req.warmup,
    });
    this.pump();
  }

  private pump(): void {
    const worker = this.worker;
    if (!worker || !this.ready || this.inflight) return;
    const req = this.queue.shift();
    if (!req) return;
    const reqId = this.nextId++;
    const timer = setTimeout(() => {
      this.fail(new Error(`scan thread timed out after ${this.timeoutMs} ms`), {
        event: 'scan-thread-timeout',
        timeoutMs: this.timeoutMs,
      });
    }, this.timeoutMs);
    const queuedMs = req.queuedSince === null ? 0 : performance.now() - req.queuedSince;
    this.inflight = { reqId, req, queuedMs, timer };
    const msg: ScanRequest = {
      type: 'summarize',
      reqId,
      qvec: req.qvec,
      keywordIds: req.keywordIds,
      k: req.k,
    };
    worker.postMessage(msg);
  }

  /** Rejects the posted request and the whole queue, drops the thread. */
  private async fail(reason: Error, line: Record<string, unknown> | undefined): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    clearTimeout(this.loadTimer);
    const pending: Pending[] = [];
    if (this.inflight) {
      clearTimeout(this.inflight.timer);
      pending.push(this.inflight.req);
      this.inflight = undefined;
    }
    pending.push(...this.queue);
    this.queue = [];
    if (line) this.log(line);
    for (const p of pending) p.reject(reason);
    if (!worker) return;
    worker.removeAllListeners();
    worker.on('error', () => {});
    await worker.terminate().catch(() => undefined);
  }
}
