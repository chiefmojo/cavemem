import { register } from 'node:module';

// A worker_threads thread gets no Vite transforms, so the resolve hook points
// workspace imports at source and swaps `./x.js` for `./x.ts`, like the
// vitest aliases do for the main thread. Hooks must live in their own module.
register(new URL('./ts-thread-resolve.mjs', import.meta.url));
