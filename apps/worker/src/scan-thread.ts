import { parentPort, workerData } from 'node:worker_threads';
import type { VectorSummary } from '@cavemem/core';
import { Storage } from '@cavemem/storage';
import { VectorCache } from './vector-cache.js';

export interface ScanThreadData {
  dbPath: string;
  model: string;
  dim: number;
  /** Tests only: sleep this long before answering each request. */
  testDelayMs?: number;
  /** Tests only: block this long before loading, to simulate a hung load. */
  testLoadDelayMs?: number;
}

export type ScanRequest = {
  type: 'summarize';
  reqId: number;
  qvec: Float32Array;
  keywordIds: number[];
  k: number;
};

export type ScanResponse =
  | { type: 'ready'; count: number }
  | { type: 'result'; reqId: number; summary: Omit<VectorSummary, 'queuedMs' | 'warmup'> }
  | { type: 'error'; reqId: number | null; message: string };

const port = parentPort;
if (!port) throw new Error('scan-thread must run inside a worker thread');

const { dbPath, model, dim, testDelayMs, testLoadDelayMs } = workerData as ScanThreadData;
const post = (msg: ScanResponse) => port.postMessage(msg);
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Read-only so this connection can never contend for the write lock; WAL lets
// it read while the main thread keeps writing.
let cache: VectorCache | undefined;
try {
  if (testLoadDelayMs)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testLoadDelayMs);
  const storage = new Storage(dbPath, { readonly: true });
  cache = new VectorCache(storage, model, dim);
  cache.load();
  post({ type: 'ready', count: cache.size });
} catch (err) {
  post({ type: 'error', reqId: null, message: describe(err) });
  process.exitCode = 1;
  port.close();
}

if (cache) {
  const live = cache;
  port.on('message', async (msg: ScanRequest) => {
    if (msg.type !== 'summarize') return;
    try {
      if (testDelayMs) await new Promise((r) => setTimeout(r, testDelayMs));
      live.refresh();
      post({
        type: 'result',
        reqId: msg.reqId,
        summary: live.summarize(msg.qvec, msg.keywordIds, msg.k),
      });
    } catch (err) {
      post({ type: 'error', reqId: msg.reqId, message: describe(err) });
    }
  });
}
