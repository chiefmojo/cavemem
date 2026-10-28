import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const toSrc = (rel) => new URL(rel, import.meta.url).href;

// Keep in sync with vitest.shared.ts.
const WORKSPACE = {
  '@cavemem/compress': toSrc('../../../../packages/compress/src/index.ts'),
  '@cavemem/config': toSrc('../../../../packages/config/src/index.ts'),
  '@cavemem/core': toSrc('../../../../packages/core/src/index.ts'),
  '@cavemem/embedding': toSrc('../../../../packages/embedding/src/index.ts'),
  '@cavemem/storage': toSrc('../../../../packages/storage/src/index.ts'),
  '@cavemem/hooks': toSrc('../../../../packages/hooks/src/index.ts'),
  '@cavemem/installers': toSrc('../../../../packages/installers/src/index.ts'),
  '@cavemem/mcp-server': toSrc('../../../mcp-server/src/server.ts'),
  '@cavemem/worker': toSrc('../../src/server.ts'),
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = WORKSPACE[specifier];
  if (mapped) return nextResolve(mapped, context);
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (ts.protocol === 'file:' && existsSync(fileURLToPath(ts))) {
      return nextResolve(ts.href, context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const fileName = fileURLToPath(url);
    const source = await readFile(fileName, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
