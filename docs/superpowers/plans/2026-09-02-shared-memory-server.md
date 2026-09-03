# Shared Memory Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One cavemem worker on neuromancer owns the SQLite store; every agent on every LAN machine writes through hooks that POST to it and reads through MCP over streamable HTTP mounted on the same worker.

**Architecture:** A new `remote` settings block switches the existing binary into remote mode. The worker gains a configurable bind host and Host/Origin allowlist, a `POST /api/hooks/:event` endpoint that runs the unmodified hook handlers server-side, and an `ALL /mcp` route serving the existing `buildServer()` over the SDK's stateless `WebStandardStreamableHTTPServerTransport`. Hooks on client machines become a thin POST with timeout plus a bounded JSONL spool; installers emit URL-based MCP entries.

**Tech Stack:** TypeScript, pnpm workspaces, Hono + `@hono/node-server`, `@modelcontextprotocol/sdk@1.29.0`, zod, vitest, better-sqlite3, systemd.

**Spec:** `docs/superpowers/specs/2026-09-02-shared-memory-server-design.md`

## Global Constraints

- Node ≥ 20. Global `fetch` and `AbortController` are used; no HTTP client dependency is added.
- Dependency direction stays `config → compress → storage → { core, embedding } → hooks → installers`; `apps/*` may import `packages/*` and, following the existing `apps/cli` precedent, other `apps/*`. `packages/*` never import apps.
- All DB I/O stays in `@cavemem/storage`; all settings access through `@cavemem/config`.
- Every new `SettingsSchema` field carries a `.describe()` string.
- Hook handlers in `packages/hooks/src/handlers/*` are not modified except `session-start.ts` (metadata pass-through).
- `/mcp` stays behind the bearer middleware and the Origin check. No CORS headers are added.
- Default behaviour with no `remote.url`, `workerHost` at `127.0.0.1`, and empty `workerAllowedHosts` is byte-for-byte today's behaviour.
- Commits are authored `--author="Erick <chiefmojo@chiefmojo.com>"`, Conventional Commit subjects, no `Co-Authored-By` trailer.
- Gates before the PR: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `bash scripts/e2e-publish.sh`, `bash scripts/e2e-remote.sh`.
- Work on branch `feat/shared-memory-server` off `main`.

---

## File map

| Path | Change | Responsibility |
|------|--------|----------------|
| `packages/config/src/schema.ts` | modify | `remote`, `workerHost`, `workerAllowedHosts` fields |
| `packages/config/test/schema.test.ts` | modify | defaults + validation for the new fields |
| `packages/core/src/memory-store.ts` | modify | `startSession` accepts `metadata` |
| `packages/core/test/memory-store.test.ts` | modify | metadata persisted as JSON |
| `packages/hooks/src/runner.ts` | modify | host stamping, remote branch |
| `packages/hooks/src/handlers/session-start.ts` | modify | pass `input.metadata` through |
| `packages/hooks/src/remote.ts` | create | `remoteTarget`, `postHook`, `RemoteAuthError` |
| `packages/hooks/src/spool.ts` | create | `spoolPath`, `appendSpool`, `drainSpool` |
| `packages/hooks/src/auto-spawn.ts` | modify | early return in remote mode |
| `packages/hooks/src/index.ts` | modify | export the new modules |
| `packages/hooks/test/remote.test.ts` | create | `postHook` with mocked fetch |
| `packages/hooks/test/spool.test.ts` | create | append/cap/drain |
| `packages/hooks/test/runner.test.ts` | modify | host metadata, remote branch |
| `apps/worker/src/security.ts` | modify | allowlist from settings |
| `apps/worker/src/server.ts` | modify | bind host, hooks endpoint, `/mcp` |
| `apps/worker/package.json` | modify | add `@cavemem/hooks`, `@cavemem/mcp-server`, `@modelcontextprotocol/sdk` |
| `apps/worker/test/server.test.ts` | modify | allowlist, hooks endpoint |
| `apps/worker/test/mcp-http.test.ts` | create | streamable HTTP contract test |
| `apps/mcp-server/src/server.ts` | modify | `deps.embedder` injection |
| `apps/mcp-server/test/server.test.ts` | modify | injected embedder is used |
| `packages/installers/src/types.ts` | modify | `InstallContext.remote` |
| `packages/installers/src/claude-code.ts` | modify | HTTP MCP entry |
| `packages/installers/src/codex.ts` | modify | `url` + `bearer_token_env_var` |
| `packages/installers/src/opencode.ts` | modify | `type: remote` entry |
| `packages/installers/test/installers.test.ts` | modify | three remote shapes + uninstall |
| `apps/cli/src/util/mode.ts` | create | `isRemote`, `requireLocal` |
| `apps/cli/src/util/remote.ts` | create | `remoteSearch`, `probeRemote` |
| `apps/cli/src/commands/{install,search,status,doctor,worker,lifecycle,reindex,export,mcp}.ts` | modify | remote wiring / guards |
| `apps/cli/test/mode.test.ts` | create | guard behaviour |
| `scripts/e2e-remote.sh` | create | server + client end-to-end |
| `deploy/cavemem-worker.service` | create | systemd unit |
| `deploy/README.md` | create | server + client runbook |
| `docs/remote.md` | create | user docs for remote mode |
| `docs/mcp.md`, `CLAUDE.md`, `README.md`, `.changeset/shared-memory-server.md` | modify/create | contract docs, rules 6 and 9, changeset |

---

### Task 1: Settings schema for remote mode and bind host

**Files:**
- Modify: `packages/config/src/schema.ts:25-30`
- Test: `packages/config/test/schema.test.ts`

**Interfaces:**
- Produces: `Settings.remote: { url?: string; token?: string; timeoutMs: number }`, `Settings.workerHost: string`, `Settings.workerAllowedHosts: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/config/test/schema.test.ts` inside `describe('SettingsSchema', …)`:

```ts
  it('remote block defaults to no url, no token, 1500 ms timeout', () => {
    expect(defaultSettings.remote.url).toBeUndefined();
    expect(defaultSettings.remote.token).toBeUndefined();
    expect(defaultSettings.remote.timeoutMs).toBe(1500);
  });

  it('remote.url must be an http(s) URL', () => {
    expect(() => SettingsSchema.parse({ remote: { url: 'neuromancer:37777' } })).toThrow();
    const ok = SettingsSchema.parse({ remote: { url: 'http://neuromancer:37777' } });
    expect(ok.remote.url).toBe('http://neuromancer:37777');
  });

  it('workerHost defaults to loopback and workerAllowedHosts to empty', () => {
    expect(defaultSettings.workerHost).toBe('127.0.0.1');
    expect(defaultSettings.workerAllowedHosts).toEqual([]);
  });

  it('workerAllowedHosts entries must be host:port', () => {
    expect(() => SettingsSchema.parse({ workerAllowedHosts: ['neuromancer'] })).toThrow();
    const ok = SettingsSchema.parse({ workerAllowedHosts: ['neuromancer:37777', '10.0.0.5:37777'] });
    expect(ok.workerAllowedHosts).toHaveLength(2);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cavemem/config test`
Expected: 4 failures, `remote` / `workerHost` undefined.

- [ ] **Step 3: Add the fields**

In `packages/config/src/schema.ts`, directly after the `workerPort` field (line 30), insert:

```ts
    workerHost: z
      .string()
      .default('127.0.0.1')
      .describe(
        'Interface the worker binds to. 127.0.0.1 (default) keeps it local; 0.0.0.0 exposes it ' +
          'on the LAN for remote-mode clients. Off loopback you must also set workerAllowedHosts.',
      ),
    workerAllowedHosts: z
      .array(z.string().regex(/^[^\s:/]+:\d{1,5}$/, 'expected host:port'))
      .default([])
      .describe(
        'Extra host:port values accepted in the Host/Origin headers, e.g. ["neuromancer:37777"]. ' +
          'Loopback is always accepted. Empty means loopback only, even when workerHost is 0.0.0.0.',
      ),
    remote: z
      .object({
        url: z
          .string()
          .url()
          .regex(/^https?:\/\//, 'expected http(s) URL')
          .optional()
          .describe(
            'Base URL of a central cavemem worker, e.g. http://neuromancer:37777. Setting it ' +
              'switches this machine into remote mode: hooks POST to the server and installers ' +
              'write URL-based MCP entries.',
          ),
        token: z
          .string()
          .optional()
          .describe('Bearer token from the server\'s worker-token file.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(1500)
          .describe('Abort deadline for a hook POST to the remote worker.'),
      })
      .default({ timeoutMs: 1500 })
      .describe('Remote mode. Leave url unset for the default local mode.'),
```

Also change the `workerPort` description to `'Port the worker binds to.'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cavemem/config test && pnpm --filter @cavemem/config typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/config
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(config): remote, workerHost, workerAllowedHosts settings"
```

---

### Task 2: `MemoryStore.startSession` accepts metadata

**Files:**
- Modify: `packages/core/src/memory-store.ts:31-39`
- Test: `packages/core/test/memory-store.test.ts`

**Interfaces:**
- Produces: `startSession(p: { id: string; ide: string; cwd: string | null; metadata?: Record<string, unknown> | null }): void`. Metadata is JSON-stringified into `sessions.metadata`.

- [ ] **Step 1: Write the failing test**

Append a new `describe` to `packages/core/test/memory-store.test.ts`:

```ts
describe('MemoryStore.startSession — metadata', () => {
  it('persists metadata as JSON on the session row', () => {
    const store = new MemoryStore({ dbPath: join(dir, 'm.db'), settings: defaultSettings });
    store.startSession({ id: 's-meta', ide: 'test', cwd: null, metadata: { host: 'wintermute' } });
    const row = store.storage.getSession('s-meta');
    expect(row?.metadata).toBe(JSON.stringify({ host: 'wintermute' }));
    store.close();
  });

  it('leaves metadata null when omitted', () => {
    const store = new MemoryStore({ dbPath: join(dir, 'n.db'), settings: defaultSettings });
    store.startSession({ id: 's-nometa', ide: 'test', cwd: null });
    expect(store.storage.getSession('s-nometa')?.metadata).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cavemem/core test`
Expected: first test fails, `metadata` is `null`.

- [ ] **Step 3: Implement**

Replace `startSession` in `packages/core/src/memory-store.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @cavemem/core test && pnpm --filter @cavemem/core typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(core): startSession accepts session metadata"
```

---

### Task 3: Hooks stamp the originating host on every payload

**Files:**
- Modify: `packages/hooks/src/runner.ts`
- Modify: `packages/hooks/src/handlers/session-start.ts:7-12`
- Test: `packages/hooks/test/runner.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.startSession({ …, metadata })` from Task 2.
- Produces: every `HookInput` reaching a handler has `metadata.host` set to `os.hostname()` unless the caller already set it.

- [ ] **Step 1: Write the failing test**

Append inside `describe('runHook', …)` in `packages/hooks/test/runner.test.ts`:

```ts
  it('session-start stores the originating host in session metadata', async () => {
    await runHook('session-start', { session_id: 'sess-host', ide: 'claude-code' }, { store });
    const row = store.storage.getSession('sess-host');
    const meta = JSON.parse(row?.metadata ?? '{}') as { host?: string };
    expect(meta.host).toBe(hostname());
  });

  it('a caller-supplied metadata.host wins over the local hostname', async () => {
    await runHook(
      'session-start',
      { session_id: 'sess-host2', ide: 'claude-code', metadata: { host: 'elsewhere' } },
      { store },
    );
    const meta = JSON.parse(store.storage.getSession('sess-host2')?.metadata ?? '{}');
    expect(meta.host).toBe('elsewhere');
  });
```

Add `import { hostname } from 'node:os';` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cavemem/hooks test`
Expected: `meta.host` undefined.

- [ ] **Step 3: Implement**

In `packages/hooks/src/handlers/session-start.ts` replace the `startSession` call:

```ts
  store.startSession({
    id: input.session_id,
    ide: input.ide ?? 'unknown',
    cwd: input.cwd ?? null,
    metadata: input.metadata ?? null,
  });
```

In `packages/hooks/src/runner.ts` add `import { hostname } from 'node:os';` and, as the first statement inside the `try` block of `runHook`, before the `switch`:

```ts
    // Stamp the originating machine. In remote mode the server sees many
    // hosts sharing one store; in local mode it makes a later migration to
    // remote mode attributable.
    if (typeof input.metadata?.host !== 'string') {
      input.metadata = { ...(input.metadata ?? {}), host: hostname() };
    }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @cavemem/hooks test && pnpm --filter @cavemem/hooks typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/hooks
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(hooks): stamp originating host into session metadata"
```

---

### Task 4: Worker Host/Origin allowlist from settings and configurable bind host

**Files:**
- Modify: `apps/worker/src/security.ts:42-62`
- Modify: `apps/worker/src/server.ts:15-33,166-172`
- Test: `apps/worker/test/server.test.ts`

**Interfaces:**
- Produces: `allowedHostSet(port: number, extra: string[]): Set<string>`, `hostAllowlist(allowed: Set<string>)`, `originCheck(allowed: Set<string>)`. `BuildAppOptions` gains `allowedHosts?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` in `apps/worker/test/server.test.ts`:

```ts
describe('worker allowlist', () => {
  it('rejects a LAN Host header when no allowlist is configured', async () => {
    const res = await app.request('/healthz', { headers: { host: 'neuromancer:37777' } });
    expect(res.status).toBe(403);
  });

  it('accepts a configured LAN Host header and still accepts loopback', async () => {
    const lan = buildApp(store, { port: PORT, token: TOKEN, allowedHosts: ['neuromancer:37777'] });
    const a = await lan.request('/healthz', { headers: { host: 'neuromancer:37777' } });
    expect(a.status).toBe(200);
    const b = await lan.request('/healthz', { headers: { host: HOST } });
    expect(b.status).toBe(200);
    const c = await lan.request('/healthz', { headers: { host: 'other:37777' } });
    expect(c.status).toBe(403);
  });

  it('accepts an Origin matching an allowlisted host and rejects others', async () => {
    const lan = buildApp(store, { port: PORT, token: TOKEN, allowedHosts: ['neuromancer:37777'] });
    const ok = await lan.request('/healthz', {
      headers: { host: 'neuromancer:37777', origin: 'http://neuromancer:37777' },
    });
    expect(ok.status).toBe(200);
    const bad = await lan.request('/healthz', {
      headers: { host: 'neuromancer:37777', origin: 'http://evil.example' },
    });
    expect(bad.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cavemem/worker test`
Expected: typecheck/test failures on `allowedHosts`.

- [ ] **Step 3: Rewrite the allowlist helpers**

In `apps/worker/src/security.ts` replace `isAllowedHost`, `hostAllowlist`, and `originCheck` with:

```ts
/**
 * Loopback is always accepted so on-box tooling keeps working; `extra`
 * (settings.workerAllowedHosts) adds the names LAN clients will use. The
 * union is the whole trust boundary once workerHost is 0.0.0.0 — the bearer
 * token still gates /api/* and /mcp, but Host/Origin are what stop DNS
 * rebinding and browser CSRF.
 */
export function allowedHostSet(port: number, extra: string[]): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...extra]);
}

export function hostAllowlist(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (!host || !allowed.has(host)) {
      return c.text('Forbidden', 403);
    }
    await next();
  };
}

export function originCheck(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin) {
      let ok = false;
      for (const h of allowed) {
        if (origin === `http://${h}`) {
          ok = true;
          break;
        }
      }
      if (!ok) return c.text('Forbidden', 403);
    }
    await next();
  };
}
```

Update the doc comment at the top of the file: replace "The worker binds to 127.0.0.1 only" with "The worker binds to 127.0.0.1 by default; remote mode binds 0.0.0.0 and relies on the same three layers with `workerAllowedHosts` widening layer 1 and 2."

- [ ] **Step 4: Wire `buildApp` and `start()`**

In `apps/worker/src/server.ts`:

```ts
import { allowedHostSet, bearerAuth, getOrCreateToken, hostAllowlist, originCheck } from './security.js';

export interface BuildAppOptions {
  /** Port the worker binds to — used by the Host/Origin allowlist checks. */
  port: number;
  /** Bearer token required on /api/*; also injected into served HTML. */
  token: string;
  /** Extra host:port values accepted in Host/Origin (settings.workerAllowedHosts). */
  allowedHosts?: string[];
  loop?: EmbedLoopHandle | undefined;
}
```

In `buildApp`, replace the two middleware lines:

```ts
  const allowed = allowedHostSet(port, opts.allowedHosts ?? []);
  app.use('*', hostAllowlist(allowed));
  app.use('*', originCheck(allowed));
```

In `start()`, replace the `buildApp` + `serve` + log lines:

```ts
  const app = buildApp(store, {
    port: settings.workerPort,
    token,
    allowedHosts: settings.workerAllowedHosts,
    loop,
  });
  servers.push(
    serve({ fetch: app.fetch, port: settings.workerPort, hostname: settings.workerHost }),
  );
  process.stderr.write(
    `[cavemem worker] listening on http://${settings.workerHost}:${settings.workerPort} (pid ${process.pid})\n`,
  );
  if (settings.workerHost !== '127.0.0.1' && settings.workerAllowedHosts.length === 0) {
    process.stderr.write(
      '[cavemem worker] warning: bound off loopback with empty workerAllowedHosts — every non-loopback request will be rejected with 403\n',
    );
  }
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cavemem/worker test && pnpm --filter @cavemem/worker typecheck`
Expected: green, existing 403 tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(worker): configurable bind host and Host/Origin allowlist"
```

---

### Task 5: `POST /api/hooks/:event` runs hook handlers server-side

**Files:**
- Modify: `apps/worker/package.json` (add `"@cavemem/hooks": "workspace:*"`)
- Modify: `apps/worker/src/server.ts`
- Test: `apps/worker/test/server.test.ts`

**Interfaces:**
- Consumes: `runHook(name, input, { store })` from `@cavemem/hooks`; `HookName`, `HookInput`, `HookResult` types.
- Produces: `POST /api/hooks/:event` → `200 HookResult` (`{ ok, ms, context?, error? }`), `400 { error }` for unknown event or non-JSON / missing `session_id`, `401` without bearer.

- [ ] **Step 1: Add the dependency**

In `apps/worker/package.json` `dependencies`, add `"@cavemem/hooks": "workspace:*"`. Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/worker/test/server.test.ts`:

```ts
describe('POST /api/hooks/:event', () => {
  it('rejects without bearer', async () => {
    const res = await req('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h1' }),
    });
    expect(res.status).toBe(401);
  });

  it('runs session-start and returns a HookResult', async () => {
    const res = await apiReq('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h1', ide: 'claude-code', cwd: '/tmp', metadata: { host: 'wintermute' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; context?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.context).toBe('string');
    const row = store.storage.getSession('h1');
    expect(row?.ide).toBe('claude-code');
    expect(JSON.parse(row?.metadata ?? '{}').host).toBe('wintermute');
  });

  it('user-prompt-submit lands a compressed observation', async () => {
    await apiReq('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h2', ide: 'codex' }),
    });
    const res = await apiReq('/api/hooks/user-prompt-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h2', prompt: 'Please basically fix /etc/hosts' }),
    });
    expect(res.status).toBe(200);
    const tl = store.timeline('h2');
    expect(tl).toHaveLength(1);
    expect(tl[0]?.content).toContain('/etc/hosts');
  });

  it('400 on unknown event and on missing session_id', async () => {
    const a = await apiReq('/api/hooks/not-a-hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"session_id":"x"}',
    });
    expect(a.status).toBe(400);
    const b = await apiReq('/api/hooks/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"last_assistant_message":"hi"}',
    });
    expect(b.status).toBe(400);
    const c = await apiReq('/api/hooks/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(c.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @cavemem/worker test`
Expected: 404s where 200/400 expected.

- [ ] **Step 4: Implement the route**

In `apps/worker/src/server.ts` add imports:

```ts
import { type HookInput, type HookName, runHook } from '@cavemem/hooks';
```

Add above `buildApp`:

```ts
const HOOK_NAMES: ReadonlySet<string> = new Set<HookName>([
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
  'session-end',
]);
```

Inside `buildApp`, after the `/api/search` route:

```ts
  // Remote-mode write path. The client ships the raw IDE payload; the same
  // handlers that run in local mode run here against the worker's store, so
  // redaction, exclusion, and compression stay in one place (spec decision 4).
  app.post('/api/hooks/:event', async (c) => {
    const event = c.req.param('event');
    if (!HOOK_NAMES.has(event)) {
      return c.json({ error: `unknown hook event: ${event}` }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || typeof (body as HookInput).session_id !== 'string') {
      return c.json({ error: 'session_id is required' }, 400);
    }
    const result = await runHook(event as HookName, body as HookInput, { store });
    return c.json(result);
  });
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cavemem/worker test && pnpm --filter @cavemem/worker typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/worker pnpm-lock.yaml
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(worker): POST /api/hooks/:event runs hook handlers server-side"
```

---

### Task 6: `buildServer` accepts an injected embedder

**Files:**
- Modify: `apps/mcp-server/src/server.ts:14-50`
- Test: `apps/mcp-server/test/server.test.ts`

**Interfaces:**
- Produces: `ServerDeps.embedder?: Embedder | null`. When present (including `null`), `resolveEmbedder` returns it without calling `createEmbedder`.

- [ ] **Step 1: Write the failing test**

Append to `apps/mcp-server/test/server.test.ts`:

```ts
describe('buildServer embedder injection', () => {
  it('uses the injected embedder instead of loading one', async () => {
    const calls: string[] = [];
    const fake = {
      model: 'fake',
      dim: 3,
      embed: async (text: string) => {
        calls.push(text);
        return new Float32Array([1, 0, 0]);
      },
    };
    const server = buildServer(store, defaultSettings, { embedder: fake });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), c.connect(ct)]);
    await seed();
    await c.callTool({ name: 'search', arguments: { query: 'cargo' } });
    expect(calls.length).toBeGreaterThan(0);
    await c.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cavemem/mcp-server test`
Expected: typecheck error, `embedder` not in `ServerDeps`.

- [ ] **Step 3: Implement**

In `apps/mcp-server/src/server.ts`:

```ts
export interface ServerDeps {
  /** Injected for tests; defaults to global fetch. Only used by the opt-in enrich tool. */
  fetchImpl?: typeof fetch;
  /**
   * Pre-loaded embedder (or null for "none available"). The worker passes its
   * own so the /mcp route never loads a second model. Undefined = lazy-load.
   */
  embedder?: Embedder | null;
}
```

and change the tri-state initialiser:

```ts
  let embedder: Embedder | null | undefined = deps.embedder;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @cavemem/mcp-server test && pnpm --filter @cavemem/mcp-server typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-server
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(mcp-server): accept an injected embedder in buildServer"
```

---

### Task 7: Mount MCP over streamable HTTP at `/mcp`

**Files:**
- Modify: `apps/worker/package.json` (add `"@cavemem/mcp-server": "workspace:*"`, `"@modelcontextprotocol/sdk": "^1.29.0"`)
- Modify: `apps/worker/src/server.ts`
- Create: `apps/worker/test/mcp-http.test.ts`

**Interfaces:**
- Consumes: `buildServer(store, settings, { embedder })` from Task 6; `allowedHosts` from Task 4.
- Produces: `ALL /mcp` behind bearer auth; `BuildAppOptions.embedder?: Embedder | null`.

- [ ] **Step 1: Add dependencies**

In `apps/worker/package.json` `dependencies`, add `"@cavemem/mcp-server": "workspace:*"` and `"@modelcontextprotocol/sdk": "^1.29.0"`. Run `pnpm install`. Confirm `pnpm-lock.yaml` still resolves a single `@modelcontextprotocol/sdk@1.29.0`.

- [ ] **Step 2: Write the failing integration test**

Create `apps/worker/test/mcp-http.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

const TOKEN = 'mcp-test-token';

let dir: string;
let store: MemoryStore;
let port: number;
let server: ReturnType<typeof serve>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const p = addr.port;
      s.close(() => resolve(p));
    });
  });
}

function url(): URL {
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connect(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url(), { requestInit: { headers } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-http-'));
  store = new MemoryStore({
    dbPath: join(dir, 'data.db'),
    settings: { ...defaultSettings, embedding: { ...defaultSettings.embedding, provider: 'none' } },
  });
  port = await freePort();
  const app = buildApp(store, { port, token: TOKEN, embedder: null });
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP over streamable HTTP', () => {
  it('lists tools and searches through the worker', async () => {
    store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
    const id = store.addObservation({
      session_id: 's1',
      kind: 'note',
      content: 'Please run `cargo build --release` tomorrow.',
    });
    const client = await connect({ authorization: `Bearer ${TOKEN}` });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_observations',
      'list_sessions',
      'search',
      'timeline',
    ]);
    const res = await client.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number }>;
    expect(hits.map((h) => h.id)).toContain(id);
    const bodies = await client.callTool({ name: 'get_observations', arguments: { ids: [id] } });
    const bt = (bodies.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    expect(bt).toContain('cargo build --release');
    await client.close();
  });

  it('rejects without bearer', async () => {
    await expect(connect({})).rejects.toThrow(/401/);
  });

  it('rejects a browser-style Origin', async () => {
    await expect(
      connect({ authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' }),
    ).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @cavemem/worker test`
Expected: `embedder` not in options / 404 on `/mcp`.

- [ ] **Step 4: Implement the route**

In `apps/worker/src/server.ts`:

```ts
import type { Embedder } from '@cavemem/core';
import { buildServer } from '@cavemem/mcp-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
```

Extend `BuildAppOptions`:

```ts
  /** Pre-loaded embedder shared with /mcp; null when provider=none or load failed. */
  embedder?: Embedder | null;
```

Add the bearer guard and route inside `buildApp`, next to the `/api/*` bearer line:

```ts
  app.use('/mcp', bearerAuth(token));
  // Stateless streamable HTTP: one server + transport per request, as the SDK
  // requires when sessionIdGenerator is undefined. Tool registration is five
  // calls, so the per-request cost is negligible. Real MCP clients send no
  // Origin header; the shared originCheck still applies so a browser page
  // cannot reach this route (DNS rebinding).
  app.all('/mcp', async (c) => {
    const mcp = buildServer(store, store.settings, { embedder: opts.embedder ?? null });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
```

In `start()`, pass `embedder` into `buildApp`:

```ts
  const app = buildApp(store, {
    port: settings.workerPort,
    token,
    allowedHosts: settings.workerAllowedHosts,
    embedder,
    loop,
  });
```

(`embedder` is the `let embedder = null` variable already in `start()`; widen its declaration to `let embedder: Embedder | null = null;`.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cavemem/worker test && pnpm --filter @cavemem/worker typecheck && pnpm build`
Expected: green; the CLI bundle builds with the worker now importing `@cavemem/mcp-server`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker pnpm-lock.yaml
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(worker): serve MCP over streamable HTTP at /mcp"
```

---

### Task 8: Remote hook client with spool

**Files:**
- Create: `packages/hooks/src/remote.ts`
- Create: `packages/hooks/src/spool.ts`
- Modify: `packages/hooks/src/runner.ts`
- Modify: `packages/hooks/src/auto-spawn.ts:22-25`
- Modify: `packages/hooks/src/index.ts`
- Create: `packages/hooks/test/remote.test.ts`
- Create: `packages/hooks/test/spool.test.ts`
- Modify: `packages/hooks/test/runner.test.ts`

**Interfaces:**
- Consumes: `Settings.remote` (Task 1), `POST /api/hooks/:event` contract (Task 5).
- Produces:
  - `remoteTarget(settings: Settings): { url: string; token: string | undefined; timeoutMs: number } | null`
  - `class RemoteAuthError extends Error`
  - `postHook(target, name: HookName, input: HookInput, fetchImpl?: typeof fetch): Promise<HookResult>` — throws `RemoteAuthError` on 401, plain `Error` on any other failure.
  - `spoolPath(settings): string`, `appendSpool(path, entry: SpoolEntry, cap = 500): void`, `drainSpool(path, send: (e: SpoolEntry) => Promise<void>, max = 10): Promise<number>`, `spoolDepth(path): number`.
  - `runHook` in remote mode never opens a local store and never throws.

- [ ] **Step 1: Write the failing spool tests**

Create `packages/hooks/test/spool.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SpoolEntry, appendSpool, drainSpool, spoolDepth } from '../src/spool.js';

let dir: string;
let path: string;

const entry = (n: number): SpoolEntry => ({
  name: 'user-prompt-submit',
  input: { session_id: 's', prompt: `p${n}` },
  ts: n,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-spool-'));
  path = join(dir, 'spool.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spool', () => {
  it('appends one JSON line per entry', () => {
    appendSpool(path, entry(1));
    appendSpool(path, entry(2));
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(spoolDepth(path)).toBe(2);
  });

  it('caps the file by dropping the oldest lines', () => {
    for (let i = 0; i < 7; i++) appendSpool(path, entry(i), 5);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect((JSON.parse(lines[0] ?? '{}') as SpoolEntry).ts).toBe(2);
  });

  it('drains oldest-first up to max and leaves the rest', async () => {
    for (let i = 0; i < 4; i++) appendSpool(path, entry(i));
    const sent: number[] = [];
    const n = await drainSpool(path, async (e) => { sent.push(e.ts); }, 3);
    expect(n).toBe(3);
    expect(sent).toEqual([0, 1, 2]);
    expect(spoolDepth(path)).toBe(1);
  });

  it('stops at the first failure and keeps the remainder', async () => {
    for (let i = 0; i < 3; i++) appendSpool(path, entry(i));
    const n = await drainSpool(path, async (e) => {
      if (e.ts === 1) throw new Error('down');
    });
    expect(n).toBe(1);
    expect(spoolDepth(path)).toBe(2);
  });

  it('depth is 0 when the file does not exist', () => {
    expect(spoolDepth(path)).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing remote tests**

Create `packages/hooks/test/remote.test.ts`:

```ts
import { defaultSettings } from '@cavemem/config';
import { describe, expect, it } from 'vitest';
import { RemoteAuthError, postHook, remoteTarget } from '../src/remote.js';

const target = { url: 'http://neuromancer:37777', token: 'tok', timeoutMs: 200 };

function fakeFetch(status: number, body: unknown, delayMs = 0): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (delayMs) {
      await new Promise((r, rej) => {
        const t = setTimeout(r, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('remoteTarget', () => {
  it('is null without remote.url', () => {
    expect(remoteTarget(defaultSettings)).toBeNull();
  });
  it('strips a trailing slash and carries token + timeout', () => {
    const t = remoteTarget({
      ...defaultSettings,
      remote: { url: 'http://neuromancer:37777/', token: 'x', timeoutMs: 999 },
    });
    expect(t).toEqual({ url: 'http://neuromancer:37777', token: 'x', timeoutMs: 999 });
  });
});

describe('postHook', () => {
  it('POSTs to /api/hooks/<event> with bearer and returns the HookResult', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenBody = '';
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get('authorization') ?? '';
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, ms: 3, context: 'ctx' }), { status: 200 });
    }) as typeof fetch;
    const r = await postHook(target, 'session-start', { session_id: 's1' }, f);
    expect(seenUrl).toBe('http://neuromancer:37777/api/hooks/session-start');
    expect(seenAuth).toBe('Bearer tok');
    expect(JSON.parse(seenBody).session_id).toBe('s1');
    expect(r).toEqual({ ok: true, ms: 3, context: 'ctx' });
  });

  it('throws RemoteAuthError on 401', async () => {
    await expect(
      postHook(target, 'stop', { session_id: 's' }, fakeFetch(401, 'Unauthorized')),
    ).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it('throws a plain Error on 500', async () => {
    await expect(
      postHook(target, 'stop', { session_id: 's' }, fakeFetch(500, { error: 'boom' })),
    ).rejects.toThrow(/500/);
  });

  it('aborts after timeoutMs', async () => {
    await expect(
      postHook(target, 'stop', { session_id: 's' }, fakeFetch(200, { ok: true, ms: 1 }, 1000)),
    ).rejects.toThrow(/abort/i);
  });
});
```

- [ ] **Step 3: Write the failing runner tests**

Append to `packages/hooks/test/runner.test.ts` a new `describe`. It exercises the remote branch by stubbing global `fetch` and pointing settings at a fake server via `CAVEMEM_HOME`. First widen the imports at the top of the file: the `node:fs` import becomes `{ existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync }` and the vitest import gains `vi`.

```ts
describe('runHook — remote mode', () => {
  let home: string;
  const origHome = process.env.CAVEMEM_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-remote-home-'));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        remote: { url: 'http://neuromancer:37777', token: 'tok', timeoutMs: 200 },
        embedding: { provider: 'none' },
      }),
    );
    process.env.CAVEMEM_HOME = home;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origHome === undefined) delete process.env.CAVEMEM_HOME;
    else process.env.CAVEMEM_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('POSTs instead of opening a local store and returns the server context', async () => {
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, ms: 2, context: 'remote ctx' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', f);
    const r = await runHook('session-start', { session_id: 'r1', ide: 'claude-code' });
    expect(r.ok).toBe(true);
    expect(r.context).toBe('remote ctx');
    expect(f).toHaveBeenCalledTimes(1);
    expect(existsSync(join(home, 'data.db'))).toBe(false);
  });

  it('spools on network failure and still returns ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await runHook('user-prompt-submit', { session_id: 'r2', prompt: 'hi' });
    expect(r.ok).toBe(true);
    expect(existsSync(join(home, 'spool.jsonl'))).toBe(true);
  });

  it('does not spool on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    const r = await runHook('user-prompt-submit', { session_id: 'r3', prompt: 'hi' });
    expect(r.ok).toBe(true);
    expect(existsSync(join(home, 'spool.jsonl'))).toBe(false);
  });

  it('drains the spool after a successful hook', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await runHook('user-prompt-submit', { session_id: 'r4', prompt: 'first' });
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, ms: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await runHook('stop', { session_id: 'r4', last_assistant_message: 'done' });
    // one live POST + one replayed
    expect(f).toHaveBeenCalledTimes(2);
    expect(existsSync(join(home, 'spool.jsonl')) ? readFileSync(join(home, 'spool.jsonl'), 'utf8').trim() : '').toBe('');
  });
});
```

Note `loadSettings()` resolves `CAVEMEM_HOME` first (see `packages/config/src/home.ts`), which is why the test sets it.

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @cavemem/hooks test`
Expected: module-not-found for `../src/spool.js` and `../src/remote.js`; remote runner tests fail (local store opened).

- [ ] **Step 5: Implement `spool.ts`**

Create `packages/hooks/src/spool.ts`:

```ts
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Settings, resolveDataDir } from '@cavemem/config';
import type { HookInput, HookName } from './types.js';

export interface SpoolEntry {
  name: HookName;
  input: HookInput;
  ts: number;
}

export const SPOOL_CAP = 500;
export const SPOOL_DRAIN_MAX = 10;

export function spoolPath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'spool.jsonl');
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

export function spoolDepth(path: string): number {
  return readLines(path).length;
}

/**
 * Append one entry. When the file exceeds `cap` lines the oldest are dropped —
 * durability is best-effort by design (spec: dropped observations acceptable).
 */
export function appendSpool(path: string, entry: SpoolEntry, cap = SPOOL_CAP): void {
  const line = `${JSON.stringify(entry)}\n`;
  const existing = readLines(path);
  if (existing.length + 1 > cap) {
    const kept = existing.slice(existing.length + 1 - cap);
    writeFileSync(path, `${kept.join('\n')}\n${line}`, 'utf8');
    return;
  }
  appendFileSync(path, line, 'utf8');
}

/**
 * Replay up to `max` entries oldest-first. Stops at the first `send` failure
 * and rewrites the file with whatever was not sent. Returns the count sent.
 */
export async function drainSpool(
  path: string,
  send: (entry: SpoolEntry) => Promise<void>,
  max = SPOOL_DRAIN_MAX,
): Promise<number> {
  const lines = readLines(path);
  if (lines.length === 0) return 0;
  let sent = 0;
  for (const line of lines.slice(0, max)) {
    let entry: SpoolEntry;
    try {
      entry = JSON.parse(line) as SpoolEntry;
    } catch {
      sent++; // malformed line: discard rather than wedge the queue
      continue;
    }
    try {
      await send(entry);
      sent++;
    } catch {
      break;
    }
  }
  const remaining = lines.slice(sent);
  writeFileSync(path, remaining.length ? `${remaining.join('\n')}\n` : '', 'utf8');
  return sent;
}
```

- [ ] **Step 6: Implement `remote.ts`**

Create `packages/hooks/src/remote.ts`:

```ts
import type { Settings } from '@cavemem/config';
import type { HookInput, HookName, HookResult } from './types.js';

export interface RemoteTarget {
  url: string;
  token: string | undefined;
  timeoutMs: number;
}

export class RemoteAuthError extends Error {
  constructor(message = 'remote worker rejected the bearer token (401)') {
    super(message);
    this.name = 'RemoteAuthError';
  }
}

/** Null in local mode. Trailing slash stripped so path joins are predictable. */
export function remoteTarget(settings: Settings): RemoteTarget | null {
  const url = settings.remote.url;
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ''),
    token: settings.remote.token,
    timeoutMs: settings.remote.timeoutMs,
  };
}

/**
 * One POST, one deadline. Throws RemoteAuthError on 401 (caller must not
 * spool — replay would fail identically), a plain Error for anything else.
 */
export async function postHook(
  target: RemoteTarget,
  name: HookName,
  input: HookInput,
  fetchImpl: typeof fetch = fetch,
): Promise<HookResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), target.timeoutMs);
  try {
    const res = await fetchImpl(`${target.url}/api/hooks/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token ?? ''}`,
      },
      body: JSON.stringify(input),
      signal: ac.signal,
    });
    if (res.status === 401) throw new RemoteAuthError();
    if (!res.ok) throw new Error(`remote worker returned ${res.status}`);
    return (await res.json()) as HookResult;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 7: Wire the runner and auto-spawn**

In `packages/hooks/src/runner.ts` add imports:

```ts
import { hostname } from 'node:os';
import { RemoteAuthError, type RemoteTarget, postHook, remoteTarget } from './remote.js';
import { appendSpool, drainSpool, spoolPath } from './spool.js';
```

Replace the body of `runHook` so the host stamp happens first, then the remote branch, then the existing local path unchanged:

```ts
export async function runHook(
  name: HookName,
  input: HookInput,
  opts: RunHookOptions = {},
): Promise<HookResult> {
  const start = performance.now();
  if (typeof input.metadata?.host !== 'string') {
    input.metadata = { ...(input.metadata ?? {}), host: hostname() };
  }

  const injected = opts.store !== undefined;
  let store: MemoryStore;
  let settingsForSpawn: ReturnType<typeof loadSettings> | undefined;
  if (opts.store) {
    store = opts.store;
  } else {
    const settings = loadSettings();
    const target = remoteTarget(settings);
    if (target) return runRemote(target, settings, name, input, start);
    settingsForSpawn = settings;
    const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
    store = new MemoryStore({ dbPath, settings });
  }
  // … existing try/switch/finally body unchanged …
}
```

Add below `runHook`:

```ts
function logRemote(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ remote: true, ...payload })}\n`);
}

/**
 * Remote mode: never opens a local store, never throws. Failure other than
 * auth spools the payload; any success drains a bounded slice of the spool.
 */
async function runRemote(
  target: RemoteTarget,
  settings: ReturnType<typeof loadSettings>,
  name: HookName,
  input: HookInput,
  start: number,
): Promise<HookResult> {
  const ms = () => Math.round(performance.now() - start);
  if (!target.token) {
    logRemote({ hook: name, ok: false, reason: 'no-token', error: 'remote.token is not set' });
    return { ok: true, ms: ms() };
  }
  const spool = spoolPath(settings);
  try {
    const result = await postHook(target, name, input);
    const drained = await drainSpool(spool, (e) => postHook(target, e.name, e.input).then(() => {}));
    if (drained > 0) logRemote({ hook: name, drained });
    return { ...result, ms: ms() };
  } catch (err) {
    if (err instanceof RemoteAuthError) {
      logRemote({ hook: name, ok: false, reason: 'auth', error: err.message });
      return { ok: true, ms: ms() };
    }
    const error = err instanceof Error ? err.message : String(err);
    try {
      appendSpool(spool, { name, input, ts: Date.now() });
      logRemote({ hook: name, ok: false, reason: 'unreachable', spooled: true, error });
    } catch (spoolErr) {
      logRemote({
        hook: name,
        ok: false,
        reason: 'unreachable',
        spooled: false,
        error,
        spoolError: spoolErr instanceof Error ? spoolErr.message : String(spoolErr),
      });
    }
    return { ok: true, ms: ms() };
  }
}
```

In `packages/hooks/src/auto-spawn.ts`, add as the first guard in `ensureWorkerRunning`:

```ts
  // Remote mode: the store lives on another machine; never start a local worker.
  if (settings.remote.url) return;
```

In `packages/hooks/src/index.ts` add:

```ts
export { postHook, remoteTarget, RemoteAuthError, type RemoteTarget } from './remote.js';
export { spoolPath, spoolDepth, appendSpool, drainSpool, type SpoolEntry } from './spool.js';
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @cavemem/hooks test && pnpm --filter @cavemem/hooks typecheck && pnpm lint`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add packages/hooks
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(hooks): remote mode POSTs to the central worker with a bounded spool"
```

---

### Task 9: Installers emit URL-based MCP entries in remote mode

**Files:**
- Modify: `packages/installers/src/types.ts`
- Modify: `packages/installers/src/claude-code.ts`
- Modify: `packages/installers/src/codex.ts`
- Modify: `packages/installers/src/opencode.ts`
- Test: `packages/installers/test/installers.test.ts`

**Interfaces:**
- Produces: `InstallContext.remote?: { url: string; token: string }`. Constant `CODEX_TOKEN_ENV = 'CAVEMEM_REMOTE_TOKEN'` exported from `codex.ts` and re-exported from `index.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/installers/test/installers.test.ts`:

```ts
describe('remote mode MCP entries', () => {
  const remote = { url: 'http://neuromancer:37777', token: 'tok123' };

  it('claude-code writes an http MCP entry with Authorization header', async () => {
    await claudeCode.install({ ...ctx, remote });
    const json = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(json.mcpServers.cavemem).toEqual({
      type: 'http',
      url: 'http://neuromancer:37777/mcp',
      headers: { Authorization: 'Bearer tok123' },
    });
    // hooks unchanged: still run the local CLI
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings.hooks)).toContain('hook run session-start');
    await claudeCode.uninstall({ ...ctx, remote });
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(after.mcpServers?.cavemem).toBeUndefined();
  });

  it('codex writes url + bearer_token_env_var and prints the export hint', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const msgs = await codex.install({ ...ctx, remote });
    const cfg = parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { cavemem: Record<string, unknown> };
    };
    expect(cfg.mcp_servers.cavemem).toEqual({
      url: 'http://neuromancer:37777/mcp',
      bearer_token_env_var: 'CAVEMEM_REMOTE_TOKEN',
    });
    expect(msgs.join('\n')).toContain('export CAVEMEM_REMOTE_TOKEN=');
  });

  it('opencode writes a remote MCP entry with headers', async () => {
    await openCode.install({ ...ctx, remote });
    const path = join(home, '.config', 'opencode', 'opencode.json');
    const json = JSON.parse(readFileSync(path, 'utf8'));
    expect(json.mcp.cavemem).toEqual({
      type: 'remote',
      url: 'http://neuromancer:37777/mcp',
      headers: { Authorization: 'Bearer tok123' },
      enabled: true,
    });
  });

  it('re-installing without remote flips back to stdio', async () => {
    await claudeCode.install({ ...ctx, remote });
    await claudeCode.install(ctx);
    const json = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(json.mcpServers.cavemem.command).toBe('/fake/bin/node');
    expect(json.mcpServers.cavemem.url).toBeUndefined();
  });
});
```

Check the opencode config filename the existing tests use (`configFile(ctx)` in `opencode.ts`) and adjust `path` in the third test to match.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cavemem/installers test`
Expected: typecheck error on `remote`, entries still stdio.

- [ ] **Step 3: Extend `InstallContext`**

In `packages/installers/src/types.ts` add to `InstallContext`:

```ts
  /**
   * Present when the machine is in remote mode (settings.remote.url set).
   * Installers then write a URL-based MCP entry pointing at `<url>/mcp`
   * instead of spawning `cavemem mcp` over stdio. Hook commands are the same
   * in both modes — the CLI decides whether to write locally or POST.
   */
  remote?: { url: string; token: string };
```

- [ ] **Step 4: Claude Code**

In `packages/installers/src/claude-code.ts` widen the two `mcpServers` types:

```ts
type ClaudeMcpEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  mcpServers?: Record<string, ClaudeMcpEntry>;
}

interface ClaudeJson {
  mcpServers?: Record<string, ClaudeMcpEntry>;
}
```

Replace the `deepMerge` block that writes `mcpServers` with an explicit overwrite of the `cavemem` key (deep-merging an http entry over a stdio one would leave `command` behind):

```ts
    const claudeJson = readJson<ClaudeJson>(mcpPath, {});
    const entry: ClaudeMcpEntry = ctx.remote
      ? {
          type: 'http',
          url: `${ctx.remote.url.replace(/\/+$/, '')}/mcp`,
          headers: { Authorization: `Bearer ${ctx.remote.token}` },
        }
      : // Spawn node explicitly — if command is the .js file, Claude Code's
        // MCP launcher can't exec it on Windows (EFTYPE).
        { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
    const mcpNext: ClaudeJson = {
      ...claudeJson,
      mcpServers: { ...(claudeJson.mcpServers ?? {}), cavemem: entry },
    };
    writeJson(mcpPath, mcpNext);
    messages.push(`wrote ${mcpPath}`);
```

Remove the now-unused `deepMerge` import if nothing else in the file uses it.

- [ ] **Step 5: Codex**

In `packages/installers/src/codex.ts` export the constant near the top:

```ts
export const CODEX_TOKEN_ENV = 'CAVEMEM_REMOTE_TOKEN';
```

Replace the `mcpServers.cavemem = { … }` assignment in `install`:

```ts
    mcpServers.cavemem = ctx.remote
      ? {
          url: `${ctx.remote.url.replace(/\/+$/, '')}/mcp`,
          // Codex reads the bearer from its own environment, not from config.
          bearer_token_env_var: CODEX_TOKEN_ENV,
        }
      : { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
```

After `messages.push(\`wrote ${cfgPath}\`)` add:

```ts
    if (ctx.remote) {
      messages.push(
        `codex reads the bearer token from the environment — add to your shell profile:\n` +
          `    export ${CODEX_TOKEN_ENV}=${ctx.remote.token}`,
      );
    }
```

In `packages/installers/src/index.ts` add `export { CODEX_TOKEN_ENV } from './codex.js';`.

- [ ] **Step 6: OpenCode**

In `packages/installers/src/opencode.ts` widen the `mcp` value type:

```ts
type OpenCodeMcpEntry =
  | { type: 'local'; command: string[]; enabled: boolean }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled: boolean };

interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpEntry>;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  plugin?: string[];
}
```

Replace the `deepMerge` that writes `mcp.cavemem` with an explicit key overwrite:

```ts
    const entry: OpenCodeMcpEntry = ctx.remote
      ? {
          type: 'remote',
          url: `${ctx.remote.url.replace(/\/+$/, '')}/mcp`,
          headers: { Authorization: `Bearer ${ctx.remote.token}` },
          enabled: true,
        }
      : { type: 'local', command: [ctx.nodeBin, ctx.cliPath, 'mcp'], enabled: true };
    const next: OpenCodeConfig = {
      ...current,
      mcp: { ...(current.mcp ?? {}), cavemem: entry },
    };
```

Keep the `mcpServers` migration and plugin-list code that follows unchanged. The bridge plugin symlink stays in both modes: it drives the hooks, which still run the local CLI.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @cavemem/installers test && pnpm --filter @cavemem/installers typecheck && pnpm lint`
Expected: green, including the pre-existing installer tests.

- [ ] **Step 8: Commit**

```bash
git add packages/installers
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(installers): URL-based MCP entries for remote mode"
```

---

### Task 10: CLI remote wiring and local-only guards

**Files:**
- Create: `apps/cli/src/util/mode.ts`
- Create: `apps/cli/src/util/remote.ts`
- Modify: `apps/cli/src/commands/install.ts`
- Modify: `apps/cli/src/commands/search.ts`
- Modify: `apps/cli/src/commands/status.ts`
- Modify: `apps/cli/src/commands/doctor.ts`
- Modify: `apps/cli/src/commands/worker.ts`, `lifecycle.ts`, `reindex.ts`, `export.ts`, `mcp.ts`
- Create: `apps/cli/test/mode.test.ts`

**Interfaces:**
- Consumes: `Settings.remote`, `remoteTarget` + `spoolPath` + `spoolDepth` from `@cavemem/hooks`, `CODEX_TOKEN_ENV` from `@cavemem/installers`.
- Produces: `isRemote(settings): boolean`; `requireLocal(settings, command: string): boolean` (prints `remote mode: run \`cavemem <command>\` on the server (<url>)` to stderr, sets `process.exitCode = 1`, returns `false` when remote); `remoteSearch(target, query, limit): Promise<SearchResult[]>`; `probeRemote(target): Promise<{ healthz: boolean; auth: boolean; error?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/mode.test.ts`:

```ts
import { defaultSettings } from '@cavemem/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRemote, requireLocal } from '../src/util/mode.js';

const remote = {
  ...defaultSettings,
  remote: { url: 'http://neuromancer:37777', token: 't', timeoutMs: 1500 },
};

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('mode', () => {
  it('isRemote follows remote.url', () => {
    expect(isRemote(defaultSettings)).toBe(false);
    expect(isRemote(remote)).toBe(true);
  });

  it('requireLocal passes silently in local mode', () => {
    expect(requireLocal(defaultSettings, 'reindex')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('requireLocal refuses in remote mode with exit code 1 and a pointer to the server', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(requireLocal(remote, 'reindex')).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('remote mode');
    expect(String(err.mock.calls[0]?.[0])).toContain('http://neuromancer:37777');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cavemem test`
Expected: module not found `../src/util/mode.js`.

- [ ] **Step 3: Create the utilities**

`apps/cli/src/util/mode.ts`:

```ts
import type { Settings } from '@cavemem/config';
import kleur from 'kleur';

export function isRemote(settings: Settings): boolean {
  return Boolean(settings.remote.url);
}

/**
 * Local-only commands (worker, reindex, export/import, viewer, stdio mcp)
 * have no meaning on a remote-mode client — there is no local store. Refuse
 * loudly rather than operate on an empty data.db.
 */
export function requireLocal(settings: Settings, command: string): boolean {
  if (!isRemote(settings)) return true;
  process.stderr.write(
    `${kleur.red('remote mode:')} run \`cavemem ${command}\` on the server (${settings.remote.url})\n`,
  );
  process.exitCode = 1;
  return false;
}
```

`apps/cli/src/util/remote.ts`:

```ts
import type { SearchResult } from '@cavemem/core';
import type { RemoteTarget } from '@cavemem/hooks';

function headers(target: RemoteTarget): Record<string, string> {
  return { authorization: `Bearer ${target.token ?? ''}` };
}

export async function remoteSearch(
  target: RemoteTarget,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const u = new URL(`${target.url}/api/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('limit', String(limit));
  const res = await fetch(u, {
    headers: headers(target),
    signal: AbortSignal.timeout(target.timeoutMs * 4),
  });
  if (!res.ok) throw new Error(`remote search failed: ${res.status}`);
  return (await res.json()) as SearchResult[];
}

export async function probeRemote(
  target: RemoteTarget,
): Promise<{ healthz: boolean; auth: boolean; error?: string }> {
  try {
    const h = await fetch(`${target.url}/healthz`, { signal: AbortSignal.timeout(target.timeoutMs) });
    if (!h.ok) return { healthz: false, auth: false, error: `healthz ${h.status}` };
    const a = await fetch(`${target.url}/api/state`, {
      headers: headers(target),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    return { healthz: true, auth: a.ok, ...(a.ok ? {} : { error: `api/state ${a.status}` }) };
  } catch (err) {
    return { healthz: false, auth: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Confirm `SearchResult` is exported from `@cavemem/core` (`packages/core/src/types.ts`); if only the type module exports it, add it to `packages/core/src/index.ts`.

- [ ] **Step 4: Guard the local-only commands**

Each of the following actions gets `const settings = loadSettings(); if (!requireLocal(settings, '<command>')) return;` as its first statements (import `requireLocal` from `../util/mode.js`; add `loadSettings` import where missing):

- `worker.ts`: `start`, `run`, `stop`, `status` → command names `worker start`, `worker run`, `worker stop`, `worker status`.
- `lifecycle.ts`: `start`, `stop`, `restart`, `viewer`.
- `reindex.ts`: `reindex`.
- `export.ts`: `export`, `import`.
- `mcp.ts`: `mcp`.

- [ ] **Step 5: `install` passes remote context**

In `apps/cli/src/commands/install.ts`, after `const settings = loadSettings();`:

```ts
      if (settings.remote.url && !settings.remote.token) {
        process.stderr.write(
          `${kleur.red('remote.url is set but remote.token is empty')} — copy the server's worker-token into settings first\n`,
        );
        process.exitCode = 1;
        return;
      }
      const ctx = {
        ideConfigDir: homedir(),
        cliPath: resolveCliPath(),
        nodeBin: process.execPath,
        dataDir: resolveDataDir(settings.dataDir),
        ...(settings.remote.url && settings.remote.token
          ? { remote: { url: settings.remote.url, token: settings.remote.token } }
          : {}),
      };
```

Replace the "memory writes happen in hooks — no daemon required on the hot path." line with a mode-aware one:

```ts
      process.stdout.write(
        `${kleur.dim(
          ctx.remote
            ? `remote mode — hooks and MCP talk to ${ctx.remote.url}`
            : 'memory writes happen in hooks — no daemon required on the hot path.',
        )}\n\n`,
      );
```

- [ ] **Step 6: `search` in remote mode**

In `apps/cli/src/commands/search.ts`, at the top of the action:

```ts
      const settings = loadSettings();
      const target = remoteTarget(settings);
      if (target) {
        const hits = await remoteSearch(target, query, Number(opts.limit));
        for (const h of hits) {
          process.stdout.write(
            `${h.id}\t${h.score.toFixed(3)}\t${h.session_id}\t${h.snippet.replace(/\s+/g, ' ')}\n`,
          );
        }
        return;
      }
```

Imports: `remoteTarget` from `@cavemem/hooks`, `remoteSearch` from `../util/remote.js`. Add `"@cavemem/hooks"` is already a CLI dependency.

- [ ] **Step 7: `status` and `doctor` in remote mode**

In `status.ts`, after printing `data dir:`:

```ts
      const target = remoteTarget(settings);
      if (target) {
        const probe = await probeRemote(target);
        process.stdout.write(`mode:       ${kleur.cyan('remote')} ${target.url}\n`);
        process.stdout.write(
          `server:     ${probe.healthz ? kleur.green('reachable') : kleur.red('unreachable')}` +
            `${probe.healthz ? (probe.auth ? kleur.green(' auth ok') : kleur.red(' auth failed')) : ''}` +
            `${probe.error ? kleur.dim(` (${probe.error})`) : ''}\n`,
        );
        process.stdout.write(`spool:      ${spoolDepth(spoolPath(settings))} queued\n`);
        const enabled = Object.entries(settings.ides).filter(([, v]) => v).map(([k]) => k);
        process.stdout.write(
          `ides:       ${enabled.length ? enabled.map(annotateIde).join(', ') : kleur.dim('none installed — try `cavemem install`')}\n`,
        );
        if (!probe.healthz || !probe.auth) process.exitCode = 1;
        return;
      }
```

Make the action `async`. Imports: `remoteTarget, spoolDepth, spoolPath` from `@cavemem/hooks`; `probeRemote` from `../util/remote.js`.

In `doctor.ts`, after printing `dataDir:`:

```ts
      const target = remoteTarget(settings);
      if (target) {
        process.stdout.write(`mode:     remote ${target.url}\n`);
        process.stdout.write(
          `token:    ${target.token ? kleur.green('present') : kleur.red('missing')}\n`,
        );
        if (!target.token) process.exitCode = 1;
        const probe = await probeRemote(target);
        process.stdout.write(
          `server:   ${probe.healthz ? kleur.green('ok') : kleur.red('fail')} ${probe.error ?? ''}\n`,
        );
        process.stdout.write(`auth:     ${probe.auth ? kleur.green('ok') : kleur.red('fail')}\n`);
        if (!probe.healthz || !probe.auth) process.exitCode = 1;
        if (settings.ides.codex && !process.env[CODEX_TOKEN_ENV]) {
          process.stdout.write(
            `codex:    ${kleur.yellow(`${CODEX_TOKEN_ENV} not set in this shell — codex MCP auth will fail`)}\n`,
          );
        }
        const pid = join(dir, 'worker.pid');
        if (existsSync(pid)) {
          process.stdout.write(
            `worker:   ${kleur.yellow('local pidfile present — run `cavemem stop` before relying on remote mode')}\n`,
          );
        }
        process.stdout.write(`spool:    ${spoolDepth(spoolPath(settings))} queued\n`);
        return;
      }
```

Imports: `CODEX_TOKEN_ENV` from `@cavemem/installers`, `remoteTarget, spoolDepth, spoolPath` from `@cavemem/hooks`, `probeRemote` from `../util/remote.js`.

- [ ] **Step 8: Run tests and gates**

Run: `pnpm --filter cavemem test && pnpm typecheck && pnpm lint && pnpm build`
Expected: green; `program.test.ts` still finds every command.

- [ ] **Step 9: Commit**

```bash
git add apps/cli packages/core
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat(cli): remote-mode search, status, doctor and local-only guards"
```

---

### Task 11: End-to-end remote script

**Files:**
- Create: `scripts/e2e-remote.sh`
- Modify: `.github/workflows/ci.yml` (run it after `e2e-publish.sh` if that is already wired; otherwise add both — check the file first)

**Interfaces:**
- Consumes: the packed tarball flow from `scripts/e2e-publish.sh` (build, stage-publish, `npm pack`, `npm install -g` into `.e2e/prefix`).

- [ ] **Step 1: Write the script**

Create `scripts/e2e-remote.sh`:

```bash
#!/usr/bin/env bash
# scripts/e2e-remote.sh
#
# End-to-end test of remote mode against the *published* artifact:
#   server: isolated $HOME, provider=none, worker run on a free port
#   client: second isolated $HOME with remote.url/token, every hook event
#   asserts: rows land in the server DB, client has no data.db, search
#            from the client returns a hit, MCP over HTTP answers initialize.
#
# Run from repo root:  bash scripts/e2e-remote.sh
# Requires: node >= 20, npm, pnpm, curl
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$REPO/.e2e-remote"
PACK="$WORK/pack"
PREFIX="$WORK/prefix"
SERVER_HOME="$WORK/server"
CLIENT_HOME="$WORK/client"
WORKER_PID=""

cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
rm -rf "$WORK"
mkdir -p "$PACK" "$PREFIX" "$SERVER_HOME" "$CLIENT_HOME"

cd "$REPO"
export CAVEMEM_NO_AUTOSTART=1
unset CAVEMEM_HOME XDG_DATA_HOME

echo "==> 1. build + pack"
pnpm build >/dev/null
pnpm --filter cavemem stage-publish >/dev/null
VERSION=$(node -e "console.log(require('$REPO/apps/cli/package.json').version)")
( cd "$REPO/apps/cli" && npm pack --pack-destination "$PACK" >/dev/null )
npm install --prefix "$PREFIX" --global "$PACK/cavemem-$VERSION.tgz" >/dev/null
BIN="$PREFIX/bin/cavemem"

PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

echo "==> 2. server settings (port $PORT, provider=none, idle shutdown off)"
mkdir -p "$SERVER_HOME/.cavemem"
cat > "$SERVER_HOME/.cavemem/settings.json" <<EOF
{
  "workerPort": $PORT,
  "workerHost": "127.0.0.1",
  "embedding": { "provider": "none", "idleShutdownMs": 0 }
}
EOF

echo "==> 3. start server worker"
HOME="$SERVER_HOME" "$BIN" worker run >"$WORK/worker.log" 2>&1 &
WORKER_PID=$!
for _ in $(seq 1 50); do
  if curl -fs -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fs "http://127.0.0.1:$PORT/healthz" | grep -q '"ok":true' || { echo "server never came up"; cat "$WORK/worker.log"; exit 1; }
TOKEN=$(cat "$SERVER_HOME/.cavemem/worker-token")
test -n "$TOKEN"

echo "==> 4. client settings (remote mode)"
mkdir -p "$CLIENT_HOME/.cavemem"
cat > "$CLIENT_HOME/.cavemem/settings.json" <<EOF
{
  "remote": { "url": "http://127.0.0.1:$PORT", "token": "$TOKEN" },
  "embedding": { "provider": "none" }
}
EOF
export HOME="$CLIENT_HOME"

echo "==> 5. install --ide claude-code writes an http MCP entry"
"$BIN" install --ide claude-code >/dev/null
grep -q "\"type\": \"http\"" "$HOME/.claude.json" || { echo "expected http MCP entry"; cat "$HOME/.claude.json"; exit 1; }
grep -q "/mcp" "$HOME/.claude.json"

echo "==> 6. drive full hook lifecycle from the client"
echo '{"session_id":"e2e-remote","hook_event_name":"SessionStart","source":"startup","cwd":"/tmp"}' | "$BIN" hook run session-start --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"UserPromptSubmit","prompt":"Edit the broken /etc/hosts file"}' | "$BIN" hook run user-prompt-submit --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/x.ts"},"tool_response":{"success":true}}' | "$BIN" hook run post-tool-use --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"Stop","last_assistant_message":"shipped the migration"}' | "$BIN" hook run stop --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"SessionEnd","reason":"logout"}' | "$BIN" hook run session-end --ide claude-code

echo "==> 7. client has no local database"
test ! -e "$CLIENT_HOME/.cavemem/data.db" || { echo "client wrote a local data.db"; exit 1; }

echo "==> 8. rows landed on the server"
HOME="$SERVER_HOME" "$BIN" search "hosts" | grep -q "hosts" || { echo "server has no hit"; exit 1; }

echo "==> 9. client search goes over HTTP"
"$BIN" search "hosts" | grep -q "hosts" || { echo "remote search returned no hit"; exit 1; }

echo "==> 10. status + doctor report remote mode"
"$BIN" status | grep -q "remote" || { echo "status missing remote"; exit 1; }
"$BIN" doctor | grep -q "auth:     ok" || { echo "doctor auth not ok"; "$BIN" doctor; exit 1; }

echo "==> 11. local-only command refuses"
if "$BIN" reindex 2>/dev/null; then echo "reindex should refuse in remote mode"; exit 1; fi

echo "==> 12. MCP over HTTP answers initialize"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
curl -fs -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$INIT" | grep -q '"serverInfo"' || { echo "mcp initialize failed"; exit 1; }

echo "==> 13. MCP over HTTP rejects without bearer"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$INIT")
test "$code" = "401" || { echo "expected 401, got $code"; exit 1; }

echo "==> 14. spool on outage, drain on recovery"
kill "$WORKER_PID"; wait "$WORKER_PID" 2>/dev/null || true; WORKER_PID=""
echo '{"session_id":"e2e-remote-2","hook_event_name":"UserPromptSubmit","prompt":"queued while down"}' | "$BIN" hook run user-prompt-submit --ide claude-code
test -s "$CLIENT_HOME/.cavemem/spool.jsonl" || { echo "expected a spooled entry"; exit 1; }
HOME="$SERVER_HOME" "$BIN" worker run >>"$WORK/worker.log" 2>&1 &
WORKER_PID=$!
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.1; done
echo '{"session_id":"e2e-remote-2","hook_event_name":"Stop","last_assistant_message":"back"}' | "$BIN" hook run stop --ide claude-code
test ! -s "$CLIENT_HOME/.cavemem/spool.jsonl" || { echo "spool not drained"; cat "$CLIENT_HOME/.cavemem/spool.jsonl"; exit 1; }
HOME="$SERVER_HOME" "$BIN" search "queued" | grep -q "queued" || { echo "replayed row missing"; exit 1; }

echo
echo "ALL REMOTE CHECKS PASSED"
```

`chmod +x scripts/e2e-remote.sh`.

- [ ] **Step 2: Run it**

Run: `bash scripts/e2e-remote.sh`
Expected: `ALL REMOTE CHECKS PASSED`. Fix whatever breaks in earlier tasks' code, re-run their unit tests, amend those commits or add fixup commits with clear subjects.

- [ ] **Step 3: Wire CI**

Open `.github/workflows/ci.yml`. If a step runs `bash scripts/e2e-publish.sh`, add `- run: bash scripts/e2e-remote.sh` after it. If not, add both after `pnpm test`.

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-remote.sh .github/workflows/ci.yml
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "test: end-to-end remote-mode script"
```

---

### Task 12: Deployment assets

**Files:**
- Create: `deploy/cavemem-worker.service`
- Create: `deploy/README.md`

- [ ] **Step 1: systemd unit**

Create `deploy/cavemem-worker.service`:

```ini
[Unit]
Description=cavemem shared memory worker (HTTP + MCP + embedding backfill)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentops
Group=agentops
WorkingDirectory=/home/agentops
Environment=NODE_ENV=production
Environment=CAVEMEM_NO_AUTOSTART=1
ExecStart=/home/agentops/.local/bin/cavemem worker run
Restart=on-failure
RestartSec=3
# The worker writes worker.pid / worker.state.json / worker-token here.
ReadWritePaths=/home/agentops/.cavemem
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Runbook**

Create `deploy/README.md`:

```markdown
# Deploying the shared memory server

Design: `docs/superpowers/specs/2026-09-02-shared-memory-server-design.md`. Tracks WP #194.

## Server (neuromancer, user `agentops`)

1. Create the account with a login shell:
   ```bash
   sudo useradd -m -s /bin/bash agentops
   ```
2. As `agentops`, install Node ≥ 20 (nvm or distro package) and set an npm prefix:
   ```bash
   npm config set prefix ~/.local
   ```
3. On a build box, from the fork's `main`:
   ```bash
   pnpm build && pnpm --filter cavemem stage-publish
   ( cd apps/cli && npm pack )
   scp apps/cli/cavemem-<version>.tgz agentops@neuromancer:~
   ```
   The npm registry package is upstream's frozen release; it does not contain remote mode.
4. As `agentops`:
   ```bash
   npm install -g ~/cavemem-<version>.tgz
   ```
5. Migrate the live store from wintermute (run on wintermute as chiefmojo):
   ```bash
   cavemem stop
   sqlite3 ~/.cavemem/data.db 'PRAGMA wal_checkpoint(TRUNCATE)'
   rsync -a --exclude worker.pid --exclude worker-token --exclude spool.jsonl \
     ~/.cavemem/ agentops@neuromancer:~/.cavemem/
   ```
6. As `agentops`, edit `~/.cavemem/settings.json`:
   ```json
   {
     "workerHost": "0.0.0.0",
     "workerAllowedHosts": ["neuromancer:37777", "<lan-ip>:37777"],
     "embedding": { "idleShutdownMs": 0 }
   }
   ```
   (merge into the copied file; keep `embedding.provider`/`model` as they were.)
7. Shelve the legacy store:
   ```bash
   sudo tar czf /home/agentops/legacy-faye-cavemem-2026-09-02.tgz -C /home/faye .cavemem
   sudo chown agentops:agentops /home/agentops/legacy-faye-cavemem-2026-09-02.tgz
   ```
8. Install and start the unit:
   ```bash
   sudo cp deploy/cavemem-worker.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cavemem-worker
   sudo journalctl -u cavemem-worker -n 20
   ```
   Expect `listening on http://0.0.0.0:37777`.
9. Read the token for clients:
   ```bash
   sudo cat /home/agentops/.cavemem/worker-token
   ```

## Client cutover (each dev box)

1. `cavemem stop`; confirm no `worker run` process remains.
2. `cavemem config set remote.url http://neuromancer:37777`
   `cavemem config set remote.token <token>`
3. `cavemem install --ide claude-code`, `--ide codex`, `--ide opencode`.
4. For Codex, add to the shell profile: `export CAVEMEM_REMOTE_TOKEN=<token>`.
5. `cavemem doctor` must show `server: ok` and `auth: ok`.
6. Local `~/.cavemem/data.db` stays as a fallback; delete it only once the server has been validated.

## Verification

- From wintermute: `cavemem search "<phrase from the migrated store>"` returns hits.
- Start a Claude Code session, say something distinctive, end it. `cavemem search` for it from wintermute, then from a Codex MCP `search` call.
- `sudo journalctl -u cavemem-worker -f` shows one line per hook POST when `logLevel` is `debug`.
```

- [ ] **Step 3: Commit**

```bash
git add deploy
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "docs(deploy): systemd unit and runbook for the shared memory server"
```

---

### Task 13: Docs, CLAUDE.md rules, changeset

**Files:**
- Modify: `CLAUDE.md:18,21` and the Layout block
- Modify: `docs/mcp.md`
- Create: `docs/remote.md`
- Modify: `README.md` (one short section)
- Modify: `apps/worker/codemap.md`, `packages/hooks/codemap.md` (one paragraph each)
- Create: `.changeset/shared-memory-server.md`

- [ ] **Step 1: CLAUDE.md**

Replace rule 6 with:

```markdown
6. **Privacy is enforced at the write boundary.** Content inside `<private>…</private>` tags is stripped. Paths matching `settings.excludePatterns` are never read. Neither appears in logs. The write boundary is the server's `MemoryStore`: in remote mode, raw hook payloads cross the LAN to the central worker before `excludePatterns` and `<private>` stripping apply (spec decision 4, 2026-09-02).
```

Replace rule 9 with:

```markdown
9. **No daemon on the local write path.** In local mode hooks write observations synchronously through `MemoryStore.addObservation` — never across a network or HTTP boundary. Hooks may *detach-spawn* the worker to kick off background embedding, but they must never wait on it. If the worker is down, writes still succeed; only the semantic-search side is degraded (BM25 keeps working). In remote mode (`settings.remote.url` set) hooks POST synchronously to the central worker's `/api/hooks/:event`, spool locally on failure, and never open a local store.
```

In the Layout block change the `apps/worker` line to `apps/worker       local HTTP daemon: viewer, embedding backfill, remote-mode hook endpoint, MCP over streamable HTTP at /mcp` and `apps/mcp-server` to `apps/mcp-server   stdio MCP server; buildServer() is shared with the worker's /mcp route`.

Under "End-to-end publish test" add a bullet: `bash scripts/e2e-remote.sh` — covers remote mode: server + client on one box through the packed artifact, all hook events, spool/drain, MCP over HTTP. Required alongside `e2e-publish.sh`.

- [ ] **Step 2: docs/mcp.md**

Change the opening sentence to "cavemem exposes four tools over MCP, either on a stdio server (`cavemem mcp`, local mode) or over streamable HTTP at `<remote.url>/mcp` (remote mode), plus an opt-in `enrich` tool." Add a section at the end:

```markdown
## Transport

| Mode | Transport | Client config |
|------|-----------|---------------|
| local | stdio, `cavemem mcp` | written by `cavemem install` |
| remote | streamable HTTP, `POST <remote.url>/mcp`, bearer token | written by `cavemem install` when `settings.remote.url` is set |

The HTTP transport is stateless: no session id, one server instance per request. It sits behind the worker's bearer check and Host/Origin allowlist, so browser pages cannot reach it. SSE is not offered — Codex CLI only speaks streamable HTTP and the SDK deprecates SSE.
```

- [ ] **Step 3: docs/remote.md**

Create with these sections, drawing exact values from the spec: What remote mode is; Settings (`remote.url`, `remote.token`, `remote.timeoutMs`, `workerHost`, `workerAllowedHosts`, `embedding.idleShutdownMs`); What changes on a client (hooks POST, MCP entries, `cavemem search`, refused commands list: `worker *`, `start`, `stop`, `restart`, `viewer`, `reindex`, `export`, `import`, `mcp`); Failure behaviour table copied from the spec's Error handling section; Privacy note (rule 6 wording); Pointer to `deploy/README.md`.

- [ ] **Step 4: README.md**

Add a short "Remote mode" section after the install section: three sentences, link to `docs/remote.md` and `deploy/README.md`.

- [ ] **Step 5: Codemaps**

`apps/worker/codemap.md`: add a paragraph listing `POST /api/hooks/:event`, `ALL /mcp`, `allowedHostSet`, `workerHost` bind. `packages/hooks/codemap.md`: add `remote.ts` and `spool.ts` with one line each and note the runner's remote branch.

- [ ] **Step 6: Changeset**

Create `.changeset/shared-memory-server.md`:

```markdown
---
"cavemem": minor
"@cavemem/config": minor
"@cavemem/core": minor
"@cavemem/hooks": minor
"@cavemem/installers": minor
"@cavemem/worker": minor
"@cavemem/mcp-server": minor
---

Remote mode: one central worker owns the store. `settings.remote.url` switches a machine to POST hooks to `/api/hooks/:event` and use MCP over streamable HTTP at `/mcp`. Worker gains `workerHost` and `workerAllowedHosts`. Installers write URL-based MCP entries in remote mode.
```

- [ ] **Step 7: Gates and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && bash scripts/e2e-publish.sh && bash scripts/e2e-remote.sh`
Expected: all green, both scripts end with their PASSED line.

```bash
git add CLAUDE.md docs README.md apps/worker/codemap.md packages/hooks/codemap.md .changeset
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "docs: remote mode, MCP transport, rules 6 and 9, changeset"
```

---

### Task 14: PR

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/shared-memory-server
gh pr create --title "feat: shared memory server (remote mode)" --body-file - <<'EOF'
## Claude review — implementation of WP #194

Spec: `docs/superpowers/specs/2026-09-02-shared-memory-server-design.md`
Plan: `docs/superpowers/plans/2026-09-02-shared-memory-server.md`

One central worker owns the store. `settings.remote.url` flips a machine into remote mode: hooks POST to `/api/hooks/:event`, MCP is served over streamable HTTP at `/mcp`, installers write URL-based entries, `cavemem search/status/doctor` go over HTTP, local-only commands refuse.

### Validation
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- `bash scripts/e2e-publish.sh` (15 checks)
- `bash scripts/e2e-remote.sh` (14 checks incl. spool/drain and MCP initialize)

### Not in this PR
- Live cutover on neuromancer/wintermute (runbook in `deploy/README.md`).
- oh-my-pi integration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 2: Update WP #194**

Post a comment on OpenProject WP #194 (token in `~/companion-ops/docs/openproject-api-reference.md`) linking the PR, and move status to "In progress" if it is still "New".

---

### Task 15: Live cutover (manual, after merge)

Not a coding task. Follow `deploy/README.md` top to bottom on neuromancer, then the client section on wintermute. Record in WP #194: bound host line from `journalctl`, `cavemem doctor` output from wintermute, and one successful cross-machine `cavemem search`. Then set WP #194 to "In testing".
