import path from 'node:path';
import { run } from './pipeline.js';
import { createUi } from './ui.js';

const HELP = `react-decode — reverse-engineer compiled React bundles

Usage:
  react-decode <url | file.js | dir | page.html | file.map> [options]

Options:
  -o, --out <dir>        output directory (default: ./decoded-<name>)
  -H, --header "K: V"    extra request header for remote inputs (repeatable)
      --origin <url>     origin used for OpenAPI "servers" (default: input origin)
      --no-chunks        do not follow dynamic-import / chunk references
      --max-files <n>    cap on remote files fetched (default 150)
      --no-rename        keep minified identifier names
      --no-prettier      skip prettier (babel generator output only)
      --json             print the analysis as JSON to stdout instead of writing files' summary
  -q, --quiet            no progress output
  -h, --help

Output:
  report.md  endpoints, routes, env, storage keys, secrets, libraries, ...
  decoded/   pretty-printed, de-minified code
  src/       original sources recovered from a source map (only if one exists)
`;

export async function main(argv) {
  const opts = { headers: {}, rename: true, prettier: true, followChunks: true };
  let input = null;
  let json = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '-h':
      case '--help':
        console.log(HELP);
        return;
      case '-o':
      case '--out':
        opts.out = next();
        break;
      case '-H':
      case '--header': {
        const h = next();
        const idx = h.indexOf(':');
        if (idx < 1) throw new Error(`bad header "${h}" (expected "Name: value")`);
        opts.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        break;
      }
      case '--origin':
        opts.origin = next();
        break;
      case '--no-chunks':
        opts.followChunks = false;
        break;
      case '--max-files':
        opts.maxFiles = Number(next());
        break;
      case '--no-rename':
        opts.rename = false;
        break;
      case '--no-prettier':
        opts.prettier = false;
        break;
      case '--json':
        json = true;
        break;
      case '-q':
      case '--quiet':
        quiet = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}\n\n${HELP}`);
        if (input) throw new Error('only one input is supported');
        input = a;
    }
  }
  if (!input) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  if (!opts.out) {
    let base = 'bundle';
    try {
      base = /^https?:/.test(input) ? new URL(input).hostname : path.basename(input).replace(/\.[^.]+$/, '');
    } catch {
      /* keep default */
    }
    opts.out = `decoded-${base.replace(/[^\w.-]+/g, '_')}`;
  }
  const ui = createUi(!(quiet || json));
  ui.banner();
  opts.log = (m) => ui.step(m);
  opts.onProgress = (p) => ui.progress(p);
  opts.onFinishDownload = (n) => {
    ui.finish();
    ui.step(`decoding ${n} file${n === 1 ? '' : 's'}`);
  };
  opts.onFinishDecode = () => ui.finish();

  const { outDir, report } = await run(input, opts);
  if (json) {
    console.log(JSON.stringify(report.json, null, 2));
    return;
  }
  const j = report.json;
  console.log(`\nDone → ${outDir}`);
  console.log(`  files: ${j.files.length}${j.sourceMapSources ? `, source-map sources: ${j.sourceMapSources}` : ''}`);
  console.log(`  endpoints: ${j.endpoints.length}  routes: ${j.routes.length}  realtime: ${j.realtime.length}`);
  console.log(`  env vars: ${j.env.length}  storage keys: ${j.storage.length}  secrets: ${j.secrets.length}`);
  console.log(`  report: ${path.join(outDir, 'report.md')}`);
}
