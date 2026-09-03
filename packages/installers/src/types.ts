export interface InstallContext {
  /** Directory where the IDE keeps its config. */
  ideConfigDir: string;
  /** Absolute path to the cavemem CLI entrypoint (the .js file). */
  cliPath: string;
  /**
   * Absolute path to the Node binary used to launch the CLI. IDE configs
   * must spawn `nodeBin cliPath …`, not `cliPath …` — on Windows spawning
   * a raw .js fails with EFTYPE (no associated exec handler).
   */
  nodeBin: string;
  /** Absolute path to the local data dir (e.g., ~/.cavemem). */
  dataDir: string;
  /**
   * Present when the machine is in remote mode (settings.remote.url set).
   * Installers then write a URL-based MCP entry pointing at `<url>/mcp`
   * instead of spawning `cavemem mcp` over stdio. Hook commands are the same
   * in both modes — the CLI decides whether to write locally or POST.
   */
  remote?: { url: string; token: string };
}

/**
 * Whether installing cavemem for this IDE wires up observation capture
 * (hooks fire, DB fills) or only exposes MCP query access over memory
 * captured elsewhere. See #58 — this is surfaced in `cavemem status` and
 * the README capability matrix so users aren't surprised an IDE never
 * records anything.
 */
export type CaptureLevel = 'full' | 'partial' | 'none';

export interface Installer {
  id: string;
  label: string;
  /** Capture coverage this IDE gets from `install()`. See {@link CaptureLevel}. */
  capture: CaptureLevel;
  /** Human-readable caveat about capture coverage, e.g. "no SessionEnd event". */
  captureNotes?: string;
  detect(ctx: InstallContext): Promise<boolean>;
  install(ctx: InstallContext): Promise<string[]>;
  uninstall(ctx: InstallContext): Promise<string[]>;
}
