import type { ScanClientOptions } from '../../src/scan-client.js';

const LOADER = new URL('./ts-thread-loader.mjs', import.meta.url).href;

/**
 * Options that run the scan thread from source using the TypeScript loader,
 * since a worker_threads thread gets no Vite transforms. Spread into
 * `new ScanClient({ dbPath, model, dim, ...scanThreadFromSource })`.
 */
export const scanThreadFromSource: Pick<ScanClientOptions, 'entry' | 'execArgv'> = {
  entry: new URL('../../src/scan-thread.ts', import.meta.url),
  execArgv: ['--import', LOADER],
};
