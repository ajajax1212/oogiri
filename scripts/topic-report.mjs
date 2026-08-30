/**
 * 遊んだ結果を読む。`logs/topics.jsonl` を集計して、
 * **どの型・どの骨格が引き直されたか**を出す（TOPIC-GEN.md §12）。
 *
 * 引き直しは「全員が これは違う と言った」ということなので、
 * こちらが50問読んで判断するより正確な評価になる。
 *
 *   node scripts/topic-report.mjs [--min 3]
 *
 * `--min` は「率を信用する最低の出題数」。1回出て1回引き直された骨格を
 * 100% と並べても意味が無いので、既定は3。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'logs', 'topics.jsonl');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const MIN = Number(argOf('--min', 3));

if (!existsSync(FILE)) {
  console.log('logs/topics.jsonl がありません。まだ誰も遊んでいないか、サーバーが別の場所で動いています。');
  console.log('（本番のログは Render のダッシュボードで [topic] を検索してください）');
  process.exit(0);
}

const rows = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const served = rows.filter((r) => r.event === 'served');
const dropped = rows.filter((r) => r.event === 'discarded');

if (!served.length) {
  console.log('出題の記録がありません。');
  process.exit(0);
}

const rate = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const pad = (s, n) => String(s).padEnd(n, ' ');

console.log(`\n=== 全体 ===`);
console.log(`出題 ${served.length}問 / 引き直し ${dropped.length}問（${rate(dropped.length, served.length)}）`);
console.log(`部屋 ${new Set(served.map((r) => r.code)).size}室 ・ 期間 ${served[0].at.slice(0, 16)} 〜 ${served[served.length - 1].at.slice(0, 16)}`);

/** 出題と引き直しを鍵ごとに数える */
function tally(key) {
  const m = new Map();
  for (const r of served) {
    const k = r[key];
    m.set(k, { ...(m.get(k) ?? { served: 0, dropped: 0 }), served: (m.get(k)?.served ?? 0) + 1 });
  }
  for (const r of dropped) {
    const k = r[key];
    const cur = m.get(k) ?? { served: 0, dropped: 0 };
    m.set(k, { ...cur, dropped: cur.dropped + 1 });
  }
  return [...m.entries()].map(([k, v]) => ({ k, ...v, r: v.served ? v.dropped / v.served : 0 }));
}

console.log(`\n=== 型ごと（引き直し率の高い順）===`);
for (const t of tally('type').sort((a, b) => b.r - a.r || b.served - a.served)) {
  const bar = '█'.repeat(Math.round(t.r * 20));
  console.log(`${pad(t.k, 10)} ${pad(`${t.dropped}/${t.served}`, 8)} ${pad(rate(t.dropped, t.served), 5)} ${bar}`);
}

console.log(`\n=== 骨格ごと（${MIN}問以上出たものだけ）===`);
const pats = tally('patternId').filter((p) => p.served >= MIN).sort((a, b) => b.r - a.r || b.served - a.served);
if (!pats.length) console.log(`まだ${MIN}問以上出た骨格がありません（--min 1 で全部見えます）`);
for (const p of pats) {
  const bar = '█'.repeat(Math.round(p.r * 20));
  console.log(`${pad(p.k, 10)} ${pad(`${p.dropped}/${p.served}`, 8)} ${pad(rate(p.dropped, p.served), 5)} ${bar}`);
}

const rare = tally('patternId').filter((p) => p.served > 0 && p.served < MIN);
if (rare.length) {
  console.log(`\n出題が${MIN}問未満で判断を保留した骨格: ${rare.map((p) => `${p.k}(${p.served})`).join(' ')}`);
}

console.log(`\n=== 引き直されたお題（新しい順・最大20件）===`);
if (!dropped.length) console.log('引き直しはまだ起きていません。');
for (const d of dropped.slice(-20).reverse()) {
  console.log(`  ${d.at.slice(5, 16)}  ${pad(d.patternId, 8)} ${d.text}`);
}

console.log(`\n=== 次の一手 ===`);
const worst = pats[0];
if (!dropped.length) {
  console.log('引き直しが無いので、いまの骨格と素材は場と噛み合っています。');
} else if (worst && worst.r >= 0.4) {
  console.log(`${worst.k} が ${rate(worst.dropped, worst.served)} 引き直されています。まず骨格を疑ってください。`);
  console.log('（TOPIC-GEN.md §2.2b と同じ形で「なぜ落としたか」を残してから消す）');
} else {
  console.log('特定の骨格に偏っていません。骨格ではなく素材の噛み合わせを見てください。');
  console.log('（TOPIC-GEN.md §5 の組み合わせ規則と §5.2 の役割）');
}
console.log();
