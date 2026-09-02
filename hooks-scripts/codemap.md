# hooks-scripts/

## Responsibility
Portable shell stubs that bridge IDE lifecycle hook events into the cavemem CLI. Each stub is the minimal transport layer between an editor's hook mechanism and the Node-based hook handlers in `packages/hooks`.

## Design
Each stub is a one-line bash script that `exec`s the CLI's `hook run` subcommand with a fixed event name. There is no logic here — the stubs delegate immediately to `cavemem hook run <event>`, which routes to the corresponding handler in `packages/hooks/src/handlers/`.

Five events are covered, one stub each:
- `session-start.sh` → `hook run session-start`
- `session-end.sh` → `hook run session-end`
- `post-tool-use.sh` → `hook run post-tool-use`
- `user-prompt-submit.sh` → `hook run user-prompt-submit`
- `stop.sh` → `hook run stop`

## Flow
1. Editor invokes the registered hook script on a lifecycle event.
2. Stub `exec`s `cavemem hook run <event>`.
3. The CLI reads the JSON event payload from stdin and passes it to the handler.
4. Handler writes an observation through `MemoryStore` and emits `hookSpecificOutput` to stdout.

## Integration
- Copied into per-IDE hook configuration by `packages/installers` (each IDE installer references these scripts).
- Depends on the `cavemem` CLI binary (`apps/cli`) being on `PATH`.
- The actual event handling lives in `packages/hooks`, not here.
