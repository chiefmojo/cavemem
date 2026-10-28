import { redactPrivate, redactSecrets } from '@cavemem/compress';

export interface SearchHealthOptions {
  /** p95 service time (ms) above which the scan is called out of headroom. */
  budgetMs?: number;
  /** Latency samples kept. */
  window?: number;
  /** Samples needed before p95 means anything. */
  minSamples?: number;
  /** Most recent search outcomes considered for the failure warning. */
  failWindow?: number;
  /** Failures within failWindow that raise the warning. */
  failThreshold?: number;
  log?: (line: Record<string, unknown>) => void;
}

const MAX_FAILURE_TEXT = 200;

const stderrLog = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

/**
 * Tracks how the scan thread is holding up so the server can say so. Latency is
 * the service time (total minus queue wait) of non-warmup searches, so one slow
 * burst of concurrent callers or a cold start does not read as a slow scan.
 */
export class SearchHealth {
  private readonly budgetMs: number;
  private readonly window: number;
  private readonly minSamples: number;
  private readonly failWindow: number;
  private readonly failThreshold: number;
  private readonly log: (line: Record<string, unknown>) => void;
  private service: number[] = [];
  private latestCount = 0;
  private outcomes: boolean[] = [];
  private lastFailure = '';
  private latencyWarned = false;
  private failureWarned = false;

  constructor(opts: SearchHealthOptions = {}) {
    this.budgetMs = opts.budgetMs ?? 300;
    this.window = opts.window ?? 50;
    this.minSamples = opts.minSamples ?? 20;
    this.failWindow = opts.failWindow ?? 20;
    this.failThreshold = opts.failThreshold ?? 3;
    this.log = opts.log ?? stderrLog;
  }

  recordSuccess(s: { ms: number; queuedMs: number; warmup: boolean; count: number }): void {
    this.pushOutcome(false);
    if (!s.warmup) {
      this.service.push(s.ms - s.queuedMs);
      if (this.service.length > this.window) this.service.shift();
      this.latestCount = s.count;
    }
    this.checkCrossing();
  }

  recordFailure(message: string): void {
    this.pushOutcome(true);
    this.lastFailure = redactSecrets(redactPrivate(message)).slice(0, MAX_FAILURE_TEXT);
    this.checkCrossing();
  }

  /** Nearest-rank p95 of the window; undefined until minSamples have arrived. */
  p95(): number | undefined {
    const n = this.service.length;
    if (n === 0 || n < this.minSamples) return undefined;
    const sorted = [...this.service].sort((a, b) => a - b);
    return sorted[Math.ceil(0.95 * n) - 1];
  }

  warning(): string | undefined {
    const lines = [this.latencyWarning(), this.failureWarning()].filter(
      (l): l is string => l !== undefined,
    );
    return lines.length ? lines.join('\n') : undefined;
  }

  private latencyWarning(): string | undefined {
    const p95 = this.p95();
    if (p95 === undefined || p95 <= this.budgetMs) return undefined;
    return `cavemem: hybrid search p95 ${Math.round(p95)} ms is over the ${this.budgetMs} ms budget at ${this.latestCount} vectors. The exact vector scan has reached its ceiling.`;
  }

  private failureCount(): number {
    return this.outcomes.filter(Boolean).length;
  }

  private failureWarning(): string | undefined {
    const failures = this.failureCount();
    if (failures < this.failThreshold) return undefined;
    return `cavemem: hybrid search failing (${failures} of last ${this.failWindow}): ${this.lastFailure}`;
  }

  private pushOutcome(failed: boolean): void {
    this.outcomes.push(failed);
    if (this.outcomes.length > this.failWindow) this.outcomes.shift();
  }

  // One line when each condition starts or stops holding, so a second
  // condition arriving while the first is up is still reported, and a search
  // path that stays slow for an hour does not write a line per query.
  private checkCrossing(): void {
    const latency = this.latencyWarning();
    if ((latency !== undefined) !== this.latencyWarned) {
      this.latencyWarned = latency !== undefined;
      const p95 = this.p95();
      this.log({
        event: 'search-health',
        condition: 'latency',
        state: this.latencyWarned ? 'warning' : 'ok',
        ...(p95 !== undefined ? { p95Ms: Math.round(p95), count: this.latestCount } : {}),
      });
    }
    const failure = this.failureWarning();
    if ((failure !== undefined) !== this.failureWarned) {
      this.failureWarned = failure !== undefined;
      this.log({
        event: 'search-health',
        condition: 'failures',
        state: this.failureWarned ? 'warning' : 'ok',
        failures: this.failureCount(),
        ...(this.failureWarned ? { lastError: this.lastFailure } : {}),
      });
    }
  }
}
