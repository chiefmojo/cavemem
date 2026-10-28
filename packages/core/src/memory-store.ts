import { compress, expand, redactPrivate, redactSecrets } from '@cavemem/compress';
import type { Settings } from '@cavemem/config';
import { type NewObservation, type ObservationRow, Storage } from '@cavemem/storage';
import { rankFromSummary } from './ranker.js';
import type { GetObservationsOptions, Observation, SearchResult } from './types.js';
import {
  type VectorIndex,
  type VectorSummary,
  normalizeInto,
  scanContiguous,
} from './vector-scan.js';

export interface SearchOptions {
  /** Scans vectors off the caller's thread; absent means scan in-process. */
  index?: VectorIndex;
  /** Called once per hybrid search with the scan summary, before ranking. */
  onSummary?: (s: VectorSummary) => void;
}

export interface MemoryStoreOptions {
  dbPath: string;
  settings: Settings;
}

/**
 * Facade over storage + compression. All write paths go through here to
 * enforce: redact private tags → compress → persist.
 */
export class MemoryStore {
  readonly storage: Storage;
  readonly settings: Settings;

  constructor(opts: MemoryStoreOptions) {
    this.storage = new Storage(opts.dbPath);
    this.settings = opts.settings;
  }

  close(): void {
    this.storage.close();
  }

  // --- sessions ---

  startSession(p: {
    id: string;
    ide: string;
    cwd: string | null;
    metadata?: Record<string, unknown> | null;
  }): void {
    this.storage.createSession({
      id: p.id,
      ide: p.ide,
      cwd: p.cwd,
      started_at: Date.now(),
      metadata: p.metadata ? JSON.stringify(p.metadata) : null,
    });
  }

  endSession(id: string): void {
    this.storage.endSession(id);
  }

  // --- observations ---

  addObservation(p: {
    session_id: string;
    kind: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): number {
    let redacted = redactPrivate(p.content);
    if (!redacted.trim()) return -1;
    if (this.settings.privacy.redactSecrets) redacted = redactSecrets(redacted);
    this.ensureSession(p.session_id);
    const intensity = this.settings.compression.intensity;
    const compressed = compress(redacted, { intensity });
    const obs: NewObservation = {
      session_id: p.session_id,
      kind: p.kind,
      content: compressed,
      compressed: true,
      intensity,
      ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
    };
    return this.storage.insertObservation(obs);
  }

  addSummary(p: { session_id: string; scope: 'turn' | 'session'; content: string }): number {
    let redacted = redactPrivate(p.content);
    // Summaries echo assistant turn text, which routinely repeats credentials
    // the agent just read — scrub them like observations.
    if (this.settings.privacy.redactSecrets) redacted = redactSecrets(redacted);
    this.ensureSession(p.session_id);
    const intensity = this.settings.compression.intensity;
    const out = compress(redacted, { intensity });
    return this.storage.insertSummary({
      session_id: p.session_id,
      scope: p.scope,
      content: out,
      compressed: true,
      intensity,
    });
  }

  /**
   * Idempotently materialise a sessions row before inserting child rows.
   * Claude Code does not guarantee that SessionStart fires before the first
   * UserPromptSubmit / PostToolUse — for example when cavemem is installed
   * mid-session, when a hook earlier in the chain fails, or when a user
   * resumes a session whose SessionStart was lost. Without this guard,
   * observations and summaries hit `FOREIGN KEY constraint failed`.
   */
  private ensureSession(id: string): void {
    this.storage.createSession({
      id,
      ide: 'unknown',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
  }

  // --- reads ---

  getObservations(ids: number[], opts: GetObservationsOptions = {}): Observation[] {
    const want = opts.expand ?? this.settings.compression.expandForModel;
    return this.storage.getObservations(ids).map((r) => toObservation(r, want));
  }

  timeline(sessionId: string, aroundId?: number, limit?: number): Observation[] {
    return this.storage
      .timeline(sessionId, aroundId, limit)
      .map((r) => toObservation(r, /* expand */ false));
  }

  // --- search ---

  async search(
    query: string,
    limit?: number,
    embedder?: Embedder,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const cap = limit ?? this.settings.search.defaultLimit;
    const alpha = this.settings.search.alpha;
    const keyword = this.storage.searchFts(query, cap * 2);
    // alpha = 1 gives every vector-only item a zero score, so vectors cannot
    // change the keyword ranking; skip the embed and the scan.
    if (!embedder || this.settings.embedding.provider === 'none' || alpha === 1) {
      return keyword.slice(0, cap);
    }
    const keywordIds = keyword.map((k) => k.id);

    let summary: VectorSummary;
    if (opts.index) {
      const qvec = await embedder.embed(query);
      if (qvec.length !== embedder.dim) return keyword.slice(0, cap);
      summary = await opts.index.summarize(qvec, keywordIds, cap);
    } else {
      const vectors = this.storage.allEmbeddings({ model: embedder.model, dim: embedder.dim });
      if (vectors.length === 0) return keyword.slice(0, cap);
      const qvec = await embedder.embed(query);
      if (qvec.length !== embedder.dim) {
        // Provider lied about dim — skip vector ranking rather than mix dims.
        return keyword.slice(0, cap);
      }
      const dim = embedder.dim;
      const data = new Float32Array(vectors.length * dim);
      const ids = new Float64Array(vectors.length);
      let n = 0;
      for (const v of vectors) {
        // A malformed BLOB would make normalizeInto read past the vector.
        if (v.vec.length !== dim) continue;
        normalizeInto(data, n, v.vec, dim);
        ids[n++] = v.observation_id;
      }
      summary = {
        ...scanContiguous(data, ids, n, dim, qvec, new Set(keywordIds), cap),
        queuedMs: 0,
        warmup: false,
      };
    }
    if (summary.count === 0) return keyword.slice(0, cap);
    opts.onSummary?.(summary);
    const ranked = rankFromSummary(keyword, summary, alpha).slice(0, cap);
    const infoById = new Map<number, { session_id: string; snippet: string; ts: number }>(
      keyword.map((k) => [k.id, { session_id: k.session_id, snippet: k.snippet, ts: k.ts }]),
    );
    // For vector-only hits we still need snippet/session info; fetch them.
    const missing = ranked.filter((r) => !infoById.has(r.id)).map((r) => r.id);
    if (missing.length) {
      for (const row of this.storage.getObservations(missing)) {
        infoById.set(row.id, {
          session_id: row.session_id,
          snippet: row.content.slice(0, 120),
          ts: row.ts,
        });
      }
    }
    return ranked.map((r) => {
      const info = infoById.get(r.id);
      return {
        id: r.id,
        session_id: info?.session_id ?? '',
        snippet: info?.snippet ?? '',
        score: r.score,
        ts: info?.ts ?? 0,
      };
    });
  }
}

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

function toObservation(r: ObservationRow, expandText: boolean): Observation {
  const raw = r.content;
  const content = expandText ? expand(raw) : raw;
  return {
    id: r.id,
    session_id: r.session_id,
    kind: r.kind,
    content,
    compressed: !expandText && r.compressed === 1,
    intensity: r.intensity,
    ts: r.ts,
    metadata: r.metadata ? safeParse(r.metadata) : null,
  };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
