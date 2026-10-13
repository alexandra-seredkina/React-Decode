import { readFileSync } from 'node:fs';

// Terminal UI: banner + single-line progress bar. Writes to stderr only.
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (n, s) => c(`38;5;${n}`, s);
const dim = (s) => c('2', s);

let version = '';
try {
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch {
  /* ignore */
}

const RAINBOW = [196, 202, 208, 214, 220, 190, 118, 48, 51, 39, 33, 99, 135, 171, 205];
const rainbow = (str, offset = 0, bold = false) =>
  [...str].map((ch, i) => (ch === ' ' ? ch : c(`${bold ? '1;' : ''}38;5;${RAINBOW[(i + offset) % RAINBOW.length]}`, ch))).join('');

const center = (plain, styled, width) => {
  const left = Math.floor((width - plain.length) / 2);
  return ' '.repeat(left) + styled + ' '.repeat(width - plain.length - left);
};

// the title keeps a single warm red gradient, letter by letter
const TITLE_SHADES = [217, 210, 203, 196, 160];
const title = (str) => {
  const letters = [...str].filter((ch) => ch !== ' ').length;
  let n = 0;
  return [...str]
    .map((ch) => (ch === ' ' || ch === '✧' ? ch : c(`1;38;5;${TITLE_SHADES[Math.min(4, Math.floor((n++ / letters) * 5))]}`, ch)))
    .join('');
};

export function banner() {
  const W = 37;
  const top = '─'.repeat(W);
  const side = (i) => [rainbow('│', i), rainbow('│', i + 7)];
  const row = (plain, styled, i) => {
    const [l, r] = side(i);
    return `  ${l}${center(plain, styled, W)}${r}`;
  };
  const name = ' by meowness  =^..^= ';
  const rest = W - name.length;
  const left = Math.floor(rest / 2);
  const heading = 'ʀ ᴇ ᴀ ᴄ ᴛ  ✧  ᴅ ᴇ ᴄ ᴏ ᴅ ᴇ';
  const tagline = 'minified → readable → API map';
  return [
    '',
    `  ${rainbow('╭' + top + '╮')}`,
    row('', '', 1),
    row(`✦  ${heading}  ✦`, `${rainbow('✦', 3, true)}  ${title(heading).replace('✧', rainbow('✧', 8, true))}  ${rainbow('✦', 9, true)}`, 2),
    row(tagline, rainbow(tagline, 4), 3),
    row('', '', 4),
    `  ${rainbow('╰' + '─'.repeat(left), 5)}${rainbow(name, 2, true)}${rainbow('─'.repeat(rest - left) + '╯', 9)}`,
    version ? `${' '.repeat(W - 1)}${rainbow(`v${version}`, 6)}` : '',
    '',
  ].join('\n');
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function createUi(enabled) {
  if (!enabled) {
    const noop = () => {};
    return { banner: noop, step: noop, progress: noop, finish: noop };
  }
  const tty = process.stderr.isTTY;
  let lastLen = 0;
  let lastPct = -1;
  let lastPhase = null;

  const clear = () => {
    if (tty && lastLen) process.stderr.write(`\r${' '.repeat(lastLen)}\r`);
    lastLen = 0;
  };
  const write = (s) => {
    clear();
    process.stderr.write(`${s}\n`);
  };

  return {
    banner: () => process.stderr.write(`${banner()}\n`),
    step: (msg) => write(`${red(196, '▸')} ${msg}`),
    progress({ phase, done, total, bytes }) {
      const label = phase === 'download' ? 'downloading' : 'decoding   ';
      const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
      if (phase !== lastPhase) {
        lastPhase = phase;
        lastPct = -1;
      }
      if (!tty) {
        // plain logs: one line per ~25%
        if (pct - lastPct >= 25 || done === total) {
          lastPct = pct;
          process.stderr.write(`${label.trim()} ${done}/${total} (${pct}%)\n`);
        }
        return;
      }
      const width = 24;
      const fill = Math.round((pct / 100) * width);
      const bar = rainbow('█'.repeat(fill)) + dim('░'.repeat(width - fill));
      const extra = bytes ? `  ${dim(fmtBytes(bytes))}` : '';
      const line = `  ${red(203, label)} ${bar} ${String(pct).padStart(3)}%  ${done}/${total}${extra}`;
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '').length;
      process.stderr.write(`\r${line}${' '.repeat(Math.max(0, lastLen - visible))}`);
      lastLen = visible;
    },
    finish() {
      if (tty && lastLen) process.stderr.write('\n');
      lastLen = 0;
      lastPhase = null;
    },
  };
}
