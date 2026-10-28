import { describe, expect, it, vi } from 'vitest';
import { SearchHealth } from '../src/search-health.js';

const ok = (ms: number, extra: { queuedMs?: number; warmup?: boolean; count?: number } = {}) => ({
  ms,
  queuedMs: extra.queuedMs ?? 0,
  warmup: extra.warmup ?? false,
  count: extra.count ?? 1000,
});

function feed(h: SearchHealth, n: number, ms: number, extra = {}): void {
  for (let i = 0; i < n; i++) h.recordSuccess(ok(ms, extra));
}

const LATENCY = (p95: number, count: number) =>
  `cavemem: hybrid search p95 ${p95} ms is over the 300 ms budget at ${count} vectors. The exact vector scan has reached its ceiling.`;

describe('SearchHealth latency', () => {
  it('no warning below 20 samples', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 19, 900);
    expect(h.p95()).toBeUndefined();
    expect(h.warning()).toBeUndefined();
  });

  it('latency warning above 300 ms p95', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 20, 400, { count: 310000 });
    expect(h.p95()).toBe(400);
    expect(h.warning()).toBe(LATENCY(400, 310000));
  });

  it('is quiet at exactly the budget', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 20, 300);
    expect(h.warning()).toBeUndefined();
  });

  it('uses nearest-rank p95', () => {
    const h = new SearchHealth({ log: () => {} });
    for (let i = 1; i <= 20; i++) h.recordSuccess(ok(i * 10));
    // ceil(0.95 * 20) = 19th smallest
    expect(h.p95()).toBe(190);
  });

  it('rounds the reported p95 to an integer', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 20, 400.6, { count: 5 });
    expect(h.warning()).toBe(LATENCY(401, 5));
  });

  it('service time excludes queue wait', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 20, 450, { queuedMs: 300 });
    expect(h.p95()).toBe(150);
    expect(h.warning()).toBeUndefined();
  });

  it('warmup samples are ignored', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 20, 2000, { warmup: true });
    expect(h.p95()).toBeUndefined();
    expect(h.warning()).toBeUndefined();
  });

  it('window keeps the last 50', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 50, 900);
    expect(h.warning()).toBeDefined();
    feed(h, 40, 10);
    expect(h.warning()).toBeDefined();
    feed(h, 10, 10);
    expect(h.warning()).toBeUndefined();
  });

  it('reports the latest sample count', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 19, 400, { count: 1 });
    feed(h, 1, 400, { count: 777 });
    expect(h.warning()).toContain('at 777 vectors');
  });
});

describe('SearchHealth failures', () => {
  it('failure warning at 3 of last 20, not at 2', () => {
    const h = new SearchHealth({ log: () => {} });
    h.recordFailure('boom');
    h.recordFailure('boom');
    expect(h.warning()).toBeUndefined();
    h.recordFailure('boom');
    expect(h.warning()).toBe('cavemem: hybrid search failing (3 of last 20): boom');
  });

  it('failure text truncated to 200 chars', () => {
    const h = new SearchHealth({ log: () => {} });
    for (let i = 0; i < 3; i++) h.recordFailure('x'.repeat(500));
    expect(h.warning()).toBe(`cavemem: hybrid search failing (3 of last 20): ${'x'.repeat(200)}`);
  });

  it('reports the most recent failure message', () => {
    const h = new SearchHealth({ log: () => {} });
    h.recordFailure('first');
    h.recordFailure('second');
    h.recordFailure('third');
    expect(h.warning()).toContain(': third');
  });

  it('failures age out of the last 20 outcomes', () => {
    const h = new SearchHealth({ log: () => {} });
    for (let i = 0; i < 3; i++) h.recordFailure('boom');
    feed(h, 17, 1);
    expect(h.warning()).toContain('(3 of last 20)');
    feed(h, 1, 1);
    expect(h.warning()).toBeUndefined();
  });

  it('both lines when both hold, latency first', () => {
    const h = new SearchHealth({ log: () => {} });
    feed(h, 20, 400, { count: 9 });
    for (let i = 0; i < 3; i++) h.recordFailure('boom');
    expect(h.warning()).toBe(
      `${LATENCY(400, 9)}\ncavemem: hybrid search failing (3 of last 20): boom`,
    );
  });
});

describe('SearchHealth logging', () => {
  it('logs once per crossing', () => {
    const log = vi.fn();
    const h = new SearchHealth({ log });
    feed(h, 20, 400);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'search-health', condition: 'latency', state: 'warning' }),
    );
    feed(h, 10, 400);
    expect(log).toHaveBeenCalledTimes(1);
    feed(h, 50, 10);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'search-health', condition: 'latency', state: 'ok' }),
    );
    feed(h, 5, 10);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('logs failure crossings too', () => {
    const log = vi.fn();
    const h = new SearchHealth({ log });
    for (let i = 0; i < 5; i++) h.recordFailure('boom');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'failures', state: 'warning' }),
    );
  });

  // 19 slow samples leave latency one sample short of the floor; 3 failures
  // then raise the failure warning; the 20th slow sample tips latency over.
  function failuresUpLatencyJustShort(log: ReturnType<typeof vi.fn>): SearchHealth {
    const h = new SearchHealth({ log });
    feed(h, 19, 400);
    for (let i = 0; i < 3; i++) h.recordFailure('boom');
    return h;
  }

  it('logs a condition that starts while the other already holds', () => {
    const log = vi.fn();
    const h = failuresUpLatencyJustShort(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ condition: 'failures', state: 'warning' }),
    );
    log.mockClear();
    feed(h, 1, 400);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'search-health', condition: 'latency', state: 'warning' }),
    );
  });

  it('logs only the condition that cleared while the other still holds', () => {
    const log = vi.fn();
    const h = failuresUpLatencyJustShort(log);
    feed(h, 1, 400);
    log.mockClear();
    // Slow successes keep latency up while the failures age out of the window.
    feed(h, 16, 400);
    expect(log).not.toHaveBeenCalled();
    feed(h, 1, 400);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'failures', state: 'ok' }),
    );
    expect(h.warning()).toContain('p95');
    expect(h.warning()).not.toContain('failing');
  });

  it('writes nothing when neither condition changes', () => {
    const log = vi.fn();
    const h = new SearchHealth({ log });
    feed(h, 30, 10);
    expect(log).not.toHaveBeenCalled();
    feed(h, 20, 400);
    for (let i = 0; i < 3; i++) h.recordFailure('boom');
    log.mockClear();
    h.recordFailure('boom again');
    feed(h, 1, 400);
    expect(log).not.toHaveBeenCalled();
  });
});
