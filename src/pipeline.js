import fs from 'node:fs/promises';
import path from 'node:path';
import * as prettier from 'prettier';
import { parseSource, traverse, generate } from './ast.js';
import { normalize } from './normalize.js';
import { renameIdentifiers } from './rename.js';
import { analyzeRequests } from './analyze/requests.js';
import { analyzeStatic } from './analyze/static.js';
import { loadInput } from './loader.js';
import { extractSources } from './sourcemap.js';
import { buildReport } from './report.js';

async function pretty(code, opts) {
  if (!opts.prettier || code.length > 4_000_000) return code;
  try {
    return await prettier.format(code, { parser: 'babel', printWidth: 100, singleQuote: true });
  } catch {
    return code;
  }
}

async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

/** Decode + analyse one JS source. Never throws. */
export async function processCode(name, code, opts = {}) {
  const out = { name, bytes: code.length, error: null, decoded: null, renames: [], requests: null, statics: null };
  let ast;
  try {
    ast = parseSource(code, name);
  } catch (e) {
    out.error = `parse error: ${e.message}`;
    out.decoded = await pretty(code, opts);
    return out;
  }
  try {
    const parseErrors = ast.errors?.length ?? 0;
    if (parseErrors) out.parseWarnings = parseErrors;
    normalize(ast);
    let sinkNodes = new Set();
    if (opts.rename) {
      traverse.cache.clear();
      sinkNodes = analyzeRequests(ast).sinkNodes;
      traverse.cache.clear();
      out.renames = renameIdentifiers(ast, { sinkNodes });
    }
    traverse.cache.clear();
    out.requests = analyzeRequests(ast);
    out.statics = analyzeStatic(ast, code);
    out.decoded = await pretty(generate(ast), opts);
  } catch (e) {
    out.error = `analysis error: ${e.stack ?? e.message}`;
    out.decoded ??= await pretty(code, opts);
  }
  return out;
}

export async function run(input, opts) {
  const o = { rename: true, prettier: true, followChunks: true, maxFiles: 150, headers: {}, log: () => {}, ...opts };
  const outDir = path.resolve(o.out);
  o.log(`loading ${input}`);
  const loaded = await loadInput(input, o);
  if (!loaded.entries.some((e) => e.kind === 'js') && !loaded.maps.length) {
    throw new Error('no JavaScript found in input');
  }

  const results = [];
  const sourceResults = [];
  for (const entry of loaded.entries) {
    if (entry.kind !== 'js') continue;
    o.log(`decoding ${entry.name} (${(entry.code.length / 1024).toFixed(0)} KiB)`);
    const r = await processCode(entry.name, entry.code, o);
    await write(path.join(outDir, 'decoded', entry.name), r.decoded ?? '');
    results.push(r);
  }

  // original sources recovered from source maps
  for (const { forName, map } of loaded.maps) {
    for (const src of extractSources(map)) {
      await write(path.join(outDir, 'src', src.path), src.content);
      if (src.isLibrary || !/\.(jsx?|tsx?|mjs)$/.test(src.path)) continue;
      const r = await processCode(`src/${src.path}`, src.content, { ...o, rename: false, prettier: false });
      r.fromSourceMap = forName;
      sourceResults.push(r);
    }
  }

  const report = buildReport({ input, loaded, results, sourceResults, opts: o });
  await write(path.join(outDir, 'report.md'), report.markdown);
  return { outDir, report, results, loaded };
}
