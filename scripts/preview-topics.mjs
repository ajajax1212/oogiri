/**
 * 骨格を読むための仮組み。TOPIC-GEN.md §4 の生成手順を、判断に要る範囲だけ実装してある。
 *
 * これは本実装ではない。本番は src/engine/topic.ts に純粋関数として書く。
 * ここでは「骨格が実際どう埋まるか」を読むことだけが目的なので、
 * 修飾レイヤ（§6）と blocklist（§7）と手書き混入（§9）はまだ入れていない。
 *
 *   node scripts/preview-topics.mjs [--n 50] [--seed 1] [--brought]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// --- 設定（TOPIC-GEN.md §4）。監査しながら動かす数字はここに集める ---
const M = 8;               // 候補を何本作るか
const K = 6;               // 直近何問と比べるか
const COOL_PATTERN = 6;    // 骨格のクールダウン
const COOL_ENDING = 5;     // 語尾のクールダウン
const FAR_ESCAPE = 0;   // 共通タグ0の遠い組を許す確率（§5）
const BROUGHT_RATE = 0.30; // 持ち寄り語を使う回の割合（§5.1）

// 型を「除外」せず「減衰」させる。除外すると重い型ほど頻繁に外され、
// 分布が均等に潰れて重み表が意味を失う（下見1回目で実際にそうなった）。
const TYPE_DECAY = [0, 0.10, 0.35, 0.65]; // 直近1問前 / 2問前 / 3問前。それ以前は 1
const NEAR_TYPE = 3;       // 近さ計算での型一致の重み。5 だと減衰と二重に効きすぎる

const WEIGHTS = {
  setting: 17, attr: 16, act: 13, line: 13, blank: 10,
  why: 8, name: 8, hate: 6, flip: 5, common: 4, define: 3, cont: 1,  // analogy は下見3回とも外れたので廃止
};

const TYPE_LABEL = {
  setting: '状況提示', attr: '属性・特徴', act: '行為・展開', line: 'セリフ',
  blank: '穴埋め', why: '理由', name: 'モノ・名称', hate: '否定評価',
  common: 'あるある', flip: '反転', define: '定義変換', cont: '未完・継続',
};

// --- 引数 ---
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const N = Number(argOf('--n', 50));
const SEED = Number(argOf('--seed', 1));
const USE_BROUGHT = argv.includes('--brought');

// 持ち寄り語の見本。実際はロビーでプレイヤーが入れる（SPEC.md §9.2）
const BROUGHT = USE_BROUGHT ? [
  { id: 'b-1', word: 'たけし', cat: 'person' },
  { id: 'b-2', word: '駅前のドトール', cat: 'place' },
  { id: 'b-4', word: '合宿', cat: 'act' },
  { id: 'b-5', word: 'ゆかりん', cat: 'person' },
  { id: 'b-6', word: '筋トレ', cat: 'act' },
] : [];

// --- 乱数。シード付きなので同じ seed なら同じ結果が出る ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

// --- データ ---
const { patterns, slotCats } = readJson('data/topics/patterns.json');
const mod = readJson('data/topics/words/modifier.json');
const POOL = {
  person: readJson('data/topics/words/person.json').words,
  place: readJson('data/topics/words/place.json').words,
  org: readJson('data/topics/words/org.json').words,
  thing: readJson('data/topics/words/thing.json').words,
  act: readJson('data/topics/words/act.json').words,
  guise: readJson('data/topics/words/guise.json').words,
  pguise: readJson('data/topics/words/pguise.json').words,
  attr: mod.attr.words,
  time: mod.time.words,
};
for (const [cat, ws] of Object.entries(POOL)) {
  for (const w of ws) { w.cat = cat; w.tags ??= []; w.roles ??= []; }
}
// 語尾は文字列でもオブジェクトでも書ける（require を足したいものだけオブジェクトにする）
const endingsOf = (pat) => pat.endings.map((e, idx) =>
  typeof e === 'string' ? { id: `${pat.id}#${idx}`, text: e } : { id: `${pat.id}#${idx}`, ...e });

// 時も規則の対象。タグを付けたのに対象へ入れ忘れていて「台風の日に楽屋で撮られた写真」が出た。
// タグを持たない時（深夜3時・停電中）はどこにでも掛かるので pairOk 側で素通りさせる
const CONTENT = new Set(['person', 'place', 'org', 'thing', 'act', 'time']);
const used = new Set();
const usedBrought = new Set();
const recycled = [];

function available(cat) {
  const free = POOL[cat].filter((w) => !used.has(w.id));
  if (free.length) return free;
  recycled.push(cat); // 尽きたら使用済みを戻す（画面には出さない）
  for (const w of POOL[cat]) used.delete(w.id);
  return POOL[cat];
}

const overlap = (a, b) => a.tags.filter((t) => b.tags.includes(t)).length;

function pairOk(a, b, far) {
  if (a.id === b.id) return false;
  if (!a.tags.length || !b.tags.length) return true; // 場を持たない語はどこにでも掛かる
  if (a.cat === b.cat) return far ? overlap(a, b) === 0 : true;
  if (overlap(a, b) >= 1) return true;
  return rng() < FAR_ESCAPE; // 事故も少量なら新鮮味のうち（0.08 だと「忍者が冷凍餃子を落とした」が出た）
}

/** 骨格と語尾が課す役割条件（deny / require）でスロットの候補を絞る */
function allowed(slot, cands, pat, ending) {
  const deny = pat.deny?.[slot] ?? [];
  // require は骨格にも語尾にも書ける。at-02 は「どんな〜？」なら誰でもよく、
  // 「何を売っている？」のときだけ sells が要る（§5.2）
  const req = [...(pat.require?.[slot] ?? []), ...(ending?.require?.[slot] ?? [])];
  // タグでも締め出せる。「元{PERSON}が作った」の PERSON に非日常タグが入ると、
  // お題の側が先にボケてしまう（「元宇宙人が作った加湿器」）
  const denyTags = pat.denyTags?.[slot] ?? [];
  return cands.filter((w) =>
    !w.roles.some((r) => deny.includes(r))
    && !w.tags.some((g) => denyTags.includes(g))
    && req.every((r) => w.roles.includes(r)));
}

function fillSlots(pat, ending, wantBrought) {
  const far = pat.pair === 'far';
  const contentSlots = pat.slots.filter((s) => CONTENT.has(slotCats[s]));

  const slots = pat.slots;

  for (let attempt = 0; attempt < 40; attempt++) {
    const chosen = {};
    let broughtUsed = null;

    // 素材の性質に依存する骨格（「誰も使わない{THING}」「拾った{THING}」）には
    // 持ち寄り語を入れない。黙って通常生成に落とす（諦めると穴が空く）
    if (wantBrought && !ending?.noBrought && !pat.noBrought) {
      // 持ち寄り語には roles を付けられないので、条件のあるスロットには入れない // 語尾が持ち寄り語と噛み合わない（「誰のもの？」）
      const free = (s) => !(pat.deny?.[s]?.length) && !(pat.require?.[s]?.length)
        && !(pat.denyTags?.[s]?.length) && !(ending?.require?.[s]?.length);
      const cands = BROUGHT.filter((b) => !usedBrought.has(b.id)
        && contentSlots.some((s) => slotCats[s] === b.cat && free(s)));
      if (cands.length) {
        const b = pick(cands);
        const slot = pick(contentSlots.filter((s) => slotCats[s] === b.cat && free(s)));
        chosen[slot] = { ...b, tags: [], roles: [], level: 1, brought: true };
        broughtUsed = b;
      }
      // 持ち寄り語が尽きていたら、ここは黙って通常生成に落とす
    }

    let ok = true;
    for (const slot of slots) {
      if (chosen[slot]) continue;
      const taken = new Set(Object.values(chosen).map((w) => w.id));
      const cands = allowed(slot, available(slotCats[slot]), pat, ending)
        .filter((w) => !taken.has(w.id))
        // 持ち寄り語はタグ条件を免除されるので、相手が非日常だと足場が両方消える
        // （「駅前のドトールで門番に言われた一言」）。内輪の言葉は日常の語と組ませる
        .filter((w) => !broughtUsed || !w.tags.includes('非日常'));
      if (!cands.length) { ok = false; break; }
      chosen[slot] = pick(cands);
    }
    if (!ok) return null; // 条件を満たす語がそもそも無い骨格。retry しても同じ

    // 規則は先頭2つの中身スロットにだけ掛ける。3スロット全部に掛けると通る組が消える。
    // 持ち寄り語が入っている側は tags 条件を免除する（§5.1）
    if (contentSlots.length >= 2) {
      // 3要素の骨格では3つ目も先頭と噛み合わせる。先頭2つだけ見ていた頃は
      // 3つ目が野放しになり「門番が洞窟に持ち込んだ靴べら」が出た
      // 3つ目以降は「すでに決まったどれか1つ」と噛み合えばよい。先頭と全部を
      // 噛み合わせようとすると条件が厳しすぎて、40回引き直しても埋まらなくなる
      const done = [chosen[contentSlots[0]]];
      let ok2 = true;
      for (const s of contentSlots.slice(1)) {
        const w = chosen[s];
        if (w.brought || done.some((p) => p.brought || pairOk(p, w, far))) { done.push(w); continue; }
        ok2 = false; break;
      }
      if (!ok2) continue;
    }
    return { chosen, broughtUsed };
  }
  return null;
}

function render(pat, chosen, ending) {
  // 語尾が素材語をそのまま繰り返すと、語が長いときに狭く不格好になる
  // （「どんな会長のカツラ？」）。6文字以上なら fallback の「どんなの？」へ落とす
  let tail = ending ? ending.text : '';
  if (ending?.fallback) {
    const long = Object.entries(chosen)
      .some(([s, w]) => tail.includes(`{${s}}`) && Array.from(w.word).length >= 6);
    if (long) tail = ending.fallback;
  }
  let text = pat.template.replace('{E}', tail);
  for (const [slot, w] of Object.entries(chosen)) text = text.replaceAll(`{${slot}}`, w.word);
  return text.replace(/\{[A-Z]+\}/g, '').trim(); // 付かなかった枕詞のスロットを消す
}

const len = (s) => Array.from(s).length;

/** 直近K問との「近さ」。小さいほど新鮮（§4.1） */
function nearness(cand, history) {
  let score = 0;
  for (const h of history.slice(-K)) {
    const mult = h.discarded ? 2 : 1; // 引き直されたお題との一致は重く見る（§4.2）
    if (h.type === cand.type) score += NEAR_TYPE * mult;
    if (h.patternId === cand.patternId) score += 4 * mult;
    if (h.endingId && h.endingId === cand.endingId) score += 3 * mult;
    for (const id of cand.wordIds) if (h.wordIds.includes(id)) score += 2 * mult;
    for (const t of cand.tags) if (h.tags.includes(t)) score += 1 * mult;
  }
  return score;
}

/** 重み × 直近の使用による減衰。除外ではないので、重い型は自然と多く出る */
function weightedType(lastTypeAt, i) {
  const entries = Object.entries(WEIGHTS).map(([t, w]) => {
    const d = i - (lastTypeAt[t] ?? -99);
    return [t, w * (TYPE_DECAY[d] ?? 1)];
  }).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [t, w] of entries) { r -= w; if (r <= 0) return t; }
  return entries[entries.length - 1][0];
}

// --- 生成 ---
const history = [];
const lastTypeAt = {};
const lastPatAt = {};
const stats = { rejectLen: 0, fillFail: 0, brought: 0, byType: {}, byPattern: {}, byWord: {} };

for (let i = 0; i < N; i++) {
  const recentPatterns = new Set(history.slice(-COOL_PATTERN).map((h) => h.patternId));
  const recentEndings = new Set(history.slice(-COOL_ENDING).map((h) => h.endingId).filter(Boolean));
  const wantBrought = BROUGHT.length > 0 && rng() < BROUGHT_RATE;

  const type = weightedType(lastTypeAt, i); // 型はこのお題で1回だけ決める

  let best = null;
  for (let m = 0; m < M; m++) {
    let pats = patterns.filter((p) => p.type === type && !recentPatterns.has(p.id));
    if (!pats.length) pats = patterns.filter((p) => p.type === type);
    if (!pats.length) continue;
    // 同じ型の中では、いちばん長く出ていない骨格から使う。
    // 純粋なランダムだと、50問回しても一度も出ない骨格が残る
    const oldest = Math.min(...pats.map((p) => lastPatAt[p.id] ?? -99));
    const pat = pick(pats.filter((p) => (lastPatAt[p.id] ?? -99) === oldest));

    const es = endingsOf(pat);
    let ending = null;
    if (es.length) {
      const fresh = es.filter((e) => !recentEndings.has(e.id));
      ending = pick(fresh.length ? fresh : es);
    }

    const filled = fillSlots(pat, ending, wantBrought);
    if (!filled) { stats.fillFail++; continue; }

    const text = render(pat, filled.chosen, ending);
    if (len(text) > pat.maxLen) { stats.rejectLen++; continue; }

    const words = Object.values(filled.chosen);
    const cand = {
      text, type, patternId: pat.id, endingId: ending?.id ?? null,
      wordIds: words.map((w) => w.id),
      tags: [...new Set(words.flatMap((w) => w.tags ?? []))],
      chosen: filled.chosen, broughtUsed: filled.broughtUsed, discarded: false,
    };
    const score = nearness(cand, history);
    if (!best || score < best.score) best = { ...cand, score };
  }

  // 型を1つに決めてから M 回引くので、その型の骨格が全部埋まらないと穴が空く。
  // 素材が場ごとに偏っていると起きるので、最後は型をまたいで拾い直す
  if (!best) {
    // 順番に見ると id の若い骨格（ac-01）ばかり拾われて偏る。毎回並べ替えてから探す
    const shuffled = [...patterns].sort(() => rng() - 0.5);
    for (const pat of shuffled) {
      const es = endingsOf(pat);
      const ending = es.length ? pick(es) : null;
      const filled = fillSlots(pat, ending, false);
      if (!filled) continue;
      const text = render(pat, filled.chosen, ending);
      if (len(text) > pat.maxLen) continue;
      const words = Object.values(filled.chosen);
      best = { text, type: pat.type, patternId: pat.id, endingId: ending?.id ?? null,
        wordIds: words.map((w) => w.id), tags: [...new Set(words.flatMap((w) => w.tags ?? []))],
        chosen: filled.chosen, broughtUsed: null, discarded: false, score: 0 };
      break;
    }
  }
  if (!best) { console.log(`${String(i + 1).padStart(2)}. （生成できず）`); continue; }

  for (const w of Object.values(best.chosen)) if (!w.brought) used.add(w.id);
  if (best.broughtUsed) { usedBrought.add(best.broughtUsed.id); stats.brought++; }
  lastTypeAt[best.type] = i;
  lastPatAt[best.patternId] = i;
  history.push(best);

  stats.byType[best.type] = (stats.byType[best.type] ?? 0) + 1;
  stats.byPattern[best.patternId] = (stats.byPattern[best.patternId] ?? 0) + 1;
  for (const w of Object.values(best.chosen)) stats.byWord[w.word] = (stats.byWord[w.word] ?? 0) + 1;

  const mark = best.broughtUsed ? ' ★' : '';
  console.log(
    `${String(i + 1).padStart(2)}. [${TYPE_LABEL[best.type]}/${best.patternId}]${mark} ${best.text}`,
  );
}

// --- 監査（TOPIC-GEN.md §8 の骨組み） ---
const total = history.length;
console.log('\n--- 型の分布（狙い / 実際） ---');
const wSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
for (const [t, w] of Object.entries(WEIGHTS)) {
  const n = stats.byType[t] ?? 0;
  console.log(
    `${TYPE_LABEL[t].padEnd(7, '　')} 狙い ${String(Math.round((w / wSum) * 100)).padStart(2)}%  実際 ${String(Math.round((n / total) * 100)).padStart(2)}% (${n})`,
  );
}

console.log('\n--- 出番のなかった骨格 ---');
const unusedPat = patterns.filter((p) => !stats.byPattern[p.id]).map((p) => p.id);
console.log(unusedPat.length ? unusedPat.join(' ') : '（なし）');

console.log('\n--- 2回以上出た語 ---');
const repeats = Object.entries(stats.byWord).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
console.log(repeats.length ? repeats.map(([w, n]) => `${w}×${n}`).join(' ') : '（なし）');

console.log('\n--- 数字 ---');
console.log(`長さ超過で捨てた候補: ${stats.rejectLen}`);
console.log(`スロットを埋められなかった候補: ${stats.fillFail}`);
console.log(`持ち寄り語を使ったお題: ${stats.brought} / ${total}`);
console.log(`プールが尽きて戻したカテゴリ: ${recycled.length ? [...new Set(recycled)].join(' ') : 'なし'}`);
const lens = history.map((h) => len(h.text));
console.log(`文字数: 平均 ${(lens.reduce((a, b) => a + b, 0) / total).toFixed(1)} / 最短 ${Math.min(...lens)} / 最長 ${Math.max(...lens)}`);
