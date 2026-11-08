// Builds the two README diagrams in this folder: reload-cost.svg and thrash.svg.
// Node built-ins only. Same script, same bytes: no clock, no randomness, no network.
// Every number drawn here is a measurement quoted in the README.
// Run from the repo root: node docs/img/make.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));

// The palette and type from the visual brand guide. No other colors appear in the output.
const NAVY = '#001B3B';
const SAND = '#EDE7DC';
const TERRACOTTA = '#8C5348';
const OLIVE = '#59591D';
const HEAD = '#F2EDE2';
const SUB = '#D8D3CA';
const SERIF = "Georgia, 'Playfair Display', serif";
const SANS = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const W = 1200;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function text(x, y, s, o = {}) {
  const a = [`x="${num(x)}"`, `y="${num(y)}"`, `font-family="${o.serif ? SERIF : SANS}"`, `font-size="${o.size || 18}"`];
  if (o.bold) a.push('font-weight="700"');
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`);
  a.push(`fill="${o.fill || SUB}"`);
  return `<text ${a.join(' ')}>${esc(s)}</text>`;
}

function rect(x, y, w, h, o = {}) {
  const a = [`x="${num(x)}"`, `y="${num(y)}"`, `width="${num(w)}"`, `height="${num(h)}"`];
  if (o.rx) a.push(`rx="${o.rx}"`);
  a.push(`fill="${o.fill || 'none'}"`);
  if (o.stroke) a.push(`stroke="${o.stroke}"`, `stroke-width="${o.sw || 1}"`);
  return `<rect ${a.join(' ')}/>`;
}

function line(x1, y1, x2, y2, o = {}) {
  const dash = o.dash ? ` stroke-dasharray="${o.dash}"` : '';
  return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${o.stroke || SUB}" stroke-width="${o.sw || 1}"${dash}/>`;
}

// A straight arrow with a drawn head (no markers, so every renderer draws it the same).
function arrow(x1, y1, x2, y2, o = {}) {
  const stroke = o.stroke || SAND;
  const head = o.head || 12;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * head;
  const by = y2 - uy * head;
  const px = -uy * head * 0.5;
  const py = ux * head * 0.5;
  return [
    line(x1, y1, bx, by, { stroke, sw: o.sw || 2 }),
    `<polygon points="${num(x2)},${num(y2)} ${num(bx + px)},${num(by + py)} ${num(bx - px)},${num(by - py)}" fill="${stroke}"/>`,
  ];
}

function svg(h, title, desc, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(title)}</title>`,
    `<desc id="desc">${esc(desc)}</desc>`,
    rect(0.5, 0.5, W - 1, h - 1, { fill: NAVY, stroke: SAND }),
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

function reloadCost() {
  const H = 450;
  const X0 = 290;
  const PX_PER_S = 700 / 120;
  const xOf = (s) => X0 + s * PX_PER_S;
  // The A/B from the README: avg wall time per call over the same 5 receipts.
  const small = { label: 'num_ctx 8192', mem: '17.4 GiB', wall: 63.4, reloads: 0 };
  const big = { label: 'num_ctx 40960', mem: '20.3 GiB', wall: 110.7, reloads: 2 };

  const b = [];
  b.push(text(40, 56, 'The window costs nothing in compute. The reload costs everything.', { serif: true, size: 30, fill: HEAD }));
  b.push(text(40, 88, 'Average wall time per call. A/B over 5 real receipts, same images, same prompt.', { size: 18 }));

  // Bar one: the small window.
  let top = 124;
  let cy = top + 36;
  b.push(text(270, cy - 2, small.label, { size: 22, bold: true, fill: HEAD, anchor: 'end' }));
  b.push(text(270, cy + 24, small.mem, { size: 18, anchor: 'end' }));
  b.push(rect(X0, top, xOf(small.wall) - X0, 72, { fill: SAND }));
  b.push(text(X0 + 20, cy + 7, `${small.reloads} reloads`, { size: 20, bold: true, fill: NAVY }));
  b.push(text(xOf(small.wall) + 16, cy + 11, `${small.wall} s`, { size: 32, bold: true, fill: HEAD }));

  // Bar two: the big window. Up to 63.4 s it is the same work; the rest is reload.
  top = 222;
  cy = top + 36;
  b.push(text(270, cy - 2, big.label, { size: 22, bold: true, fill: HEAD, anchor: 'end' }));
  b.push(text(270, cy + 24, big.mem, { size: 18, anchor: 'end' }));
  b.push(rect(X0, top, xOf(small.wall) - X0, 72, { fill: SAND }));
  b.push(rect(xOf(small.wall), top, xOf(big.wall) - xOf(small.wall), 72, { fill: TERRACOTTA }));
  b.push(text(X0 + 20, cy + 7, 'same compute', { size: 20, fill: NAVY }));
  b.push(text(xOf(small.wall) + 20, cy + 7, `${big.reloads} reloads`, { size: 20, bold: true, fill: HEAD }));
  b.push(text(xOf(big.wall) + 16, cy + 11, `${big.wall} s`, { size: 32, bold: true, fill: HEAD }));

  // Where the small window's bar ends, carried down through the big one.
  b.push(line(xOf(small.wall), 116, xOf(small.wall), 302, { stroke: SUB, dash: '5 5' }));

  // Axis, 0 to 120 seconds.
  b.push(line(X0, 316, xOf(120), 316, { stroke: SAND }));
  for (let s = 0; s <= 120; s += 20) {
    b.push(line(xOf(s), 316, xOf(s), 323, { stroke: SAND }));
    b.push(text(xOf(s), 344, String(s), { size: 17, anchor: 'middle' }));
  }
  b.push(text(xOf(60), 372, 'seconds per call', { size: 17, anchor: 'middle' }));

  b.push(text(40, 418, 'Same five receipts, same prompt, same compute to the decimal. The reload is the whole difference.', { size: 20, fill: HEAD }));

  return svg(
    H,
    'What a context reload costs',
    'Average wall time per call on the same five receipts: 63.4 seconds with num_ctx 8192 and 0 reloads, 110.7 seconds with num_ctx 40960 and 2 reloads, with identical compute.',
    b,
  );
}

function thrash() {
  const H = 490;
  const b = [];

  // Left: what happened on July 28.
  b.push(text(40, 56, 'Before: two windows, one runner', { serif: true, size: 26, fill: HEAD }));
  b.push(text(40, 84, 'July 28, 2026, 16:05 to 16:46', { size: 17 }));
  const callers = [
    { x: 60, name: 'receipt reader', ctx: 'num_ctx 8192' },
    { x: 330, name: 'voice summarizer', ctx: 'num_ctx 40960' },
  ];
  for (const c of callers) {
    b.push(rect(c.x, 112, 230, 72, { rx: 4, stroke: SAND }));
    b.push(text(c.x + 115, 142, c.name, { size: 19, bold: true, fill: HEAD, anchor: 'middle' }));
    b.push(text(c.x + 115, 168, c.ctx, { size: 18, anchor: 'middle' }));
  }
  b.push(...arrow(175, 184, 250, 282, { stroke: TERRACOTTA, sw: 3, head: 14 }));
  b.push(...arrow(445, 184, 370, 282, { stroke: TERRACOTTA, sw: 3, head: 14 }));
  b.push(text(196, 240, 'loads at 8192', { size: 17, anchor: 'end' }));
  b.push(text(424, 240, 'loads at 40960', { size: 17 }));
  b.push(text(310, 214, 'each load', { size: 17, bold: true, fill: HEAD, anchor: 'middle' }));
  b.push(text(310, 236, 'evicts the other', { size: 17, bold: true, fill: HEAD, anchor: 'middle' }));

  b.push(rect(160, 284, 300, 72, { rx: 4, stroke: SAND, sw: 2 }));
  b.push(text(310, 314, 'one runner per model', { size: 19, bold: true, fill: HEAD, anchor: 'middle' }));
  b.push(text(310, 340, '19 GB reload on each switch', { size: 17, anchor: 'middle' }));
  b.push(...arrow(310, 356, 310, 389, { stroke: TERRACOTTA, sw: 3, head: 14 }));
  b.push(rect(80, 390, 460, 76, { rx: 4, fill: TERRACOTTA }));
  b.push(text(310, 422, 'the evicted call hangs', { size: 19, bold: true, fill: HEAD, anchor: 'middle' }));
  b.push(text(310, 448, 'load timeout: Ollama returns 500 at 5m0s', { size: 18, fill: HEAD, anchor: 'middle' }));

  b.push(line(600, 40, 600, 450, { stroke: SUB }));

  // Right: the fix.
  b.push(text(620, 56, 'After: one table, one window', { serif: true, size: 26, fill: HEAD }));
  b.push(text(620, 84, 'Callers read the window instead of writing a number.', { size: 17 }));
  b.push(rect(700, 112, 380, 72, { rx: 4, stroke: SAND }));
  b.push(text(890, 142, 'config/ollama-context.json', { size: 19, bold: true, fill: HEAD, anchor: 'middle' }));
  b.push(text(890, 168, '"qwen3.6:27b": 16384', { size: 18, anchor: 'middle' }));
  b.push(...arrow(890, 184, 890, 215));
  b.push(rect(790, 216, 200, 38, { rx: 19, stroke: SAND }));
  b.push(text(890, 241, 'contextFor(model)', { size: 18, fill: HEAD, anchor: 'middle' }));
  const xs = [715, 890, 1065];
  ['caller A', 'caller B', 'caller C'].forEach((name, i) => {
    b.push(...arrow(890, 254, xs[i], 291));
    b.push(rect(xs[i] - 75, 292, 150, 64, { rx: 4, stroke: SAND }));
    b.push(text(xs[i], 320, name, { size: 19, bold: true, fill: HEAD, anchor: 'middle' }));
    b.push(text(xs[i], 344, 'num_ctx 16384', { size: 17, anchor: 'middle' }));
    b.push(...arrow(xs[i], 356, xs[i] + (890 - xs[i]) * 0.15, 389));
  });
  b.push(rect(700, 390, 380, 76, { rx: 4, fill: OLIVE }));
  b.push(text(890, 422, 'one runner stays loaded', { size: 19, bold: true, fill: HEAD, anchor: 'middle' }));
  b.push(text(890, 448, 'same window for every caller', { size: 18, fill: HEAD, anchor: 'middle' }));

  return svg(
    H,
    'Two windows thrash one runner; one table fixes it',
    'Two callers asked one model for num_ctx 8192 and 40960, so each load evicted the other with a 19 GB reload until the evicted call failed at the 5-minute timeout; after the fix every caller reads one window, 16384, from one table and the runner stays loaded.',
    b,
  );
}

writeFileSync(join(OUT, 'reload-cost.svg'), reloadCost());
writeFileSync(join(OUT, 'thrash.svg'), thrash());
console.log('wrote reload-cost.svg and thrash.svg');
