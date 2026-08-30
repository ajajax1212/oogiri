import type { BroughtWord, Handmade, TopicRecord } from './types';

/**
 * お題の生成（TOPIC-GEN.md §4）。
 *
 * データは引数で受け取る。ここでファイルを読むと純粋でなくなり、
 * テストのたびに JSON を用意する羽目になる。読むのはサーバーの仕事。
 */

export type Rng = () => number;

export type Word = {
  id: string;
  word: string;
  cat: string;
  tags: string[];
  roles: string[];
  level: number;
};

export type Ending = {
  id: string;
  text: string;
  /** 素材語が長いとき差し替える語尾（「どんな会長のカツラ？」対策） */
  fallback?: string;
  require?: Record<string, string[]>;
  noBrought?: boolean;
};

export type Pattern = {
  id: string;
  type: string;
  template: string;
  slots: string[];
  endings: (string | Omit<Ending, 'id'>)[];
  deny?: Record<string, string[]>;
  require?: Record<string, string[]>;
  denyTags?: Record<string, string[]>;
  pair?: 'far';
  maxLen: number;
  noBrought?: boolean;
};

export type TopicData = {
  slotCats: Record<string, string>;
  patterns: Pattern[];
  pool: Record<string, Word[]>;
};

// --- 監査（§8）で動かす数字はここに集める ---
const M = 8;               // 候補を何本作るか
const K = 6;               // 直近何問と比べるか
const COOL_PATTERN = 6;    // 骨格のクールダウン
const COOL_ENDING = 5;     // 語尾のクールダウン
const BROUGHT_RATE = 0.3;  // 持ち寄り語を使う回の割合
/** 手書きお題を混ぜる割合（§9）。完全自動生成には天井があるので、人の札を混ぜる */
const HANDMADE_RATE = 0.25;
const NEAR_TYPE = 3;       // 近さ計算での型一致の重み

/** 型を「除外」せず「減衰」させる。除外すると重み表が均等に潰れる（§4.0） */
const TYPE_DECAY = [0, 0.1, 0.35, 0.65];

const WEIGHTS: Record<string, number> = {
  setting: 17, attr: 16, act: 13, line: 13, blank: 10,
  why: 8, name: 8, hate: 6, flip: 5, common: 4, define: 3, cont: 1,
};

/** 組み合わせ規則の対象。修飾スロット（guise / pguise / attr）は対象外 */
const CONTENT = new Set(['person', 'place', 'org', 'thing', 'act', 'time']);

const len = (s: string) => Array.from(s).length;
const pickFrom = <T,>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng() * a.length)];

const endingsOf = (pat: Pattern): Ending[] =>
  pat.endings.map((e, i) =>
    typeof e === 'string' ? { id: `${pat.id}#${i}`, text: e } : { id: `${pat.id}#${i}`, ...e });

const overlap = (a: Word, b: Word) => a.tags.filter((t) => b.tags.includes(t)).length;

/** 意外だが答えられる組か（§5）。場を共有していない組は通さない */
function pairOk(a: Word, b: Word, far: boolean): boolean {
  if (a.id === b.id) return false;
  if (!a.tags.length || !b.tags.length) return true; // 場を持たない語はどこにでも掛かる
  if (a.cat === b.cat) return far ? overlap(a, b) === 0 : true;
  return overlap(a, b) >= 1;
}

export class TopicSource {
  private used = new Set<string>();
  private usedBrought = new Set<string>();
  private usedHand = new Set<string>();
  /** 引き直しで捨てた骨格。この部屋では二度と使わない（§4.2） */
  private burned = new Set<string>();

  constructor(private data: TopicData, private rng: Rng) {}

  /** 引き直されたお題を、以後きつく避ける */
  burn(rec: TopicRecord): void {
    this.burned.add(rec.patternId);
  }

  next(
    history: readonly TopicRecord[],
    brought: readonly BroughtWord[],
    handmade: readonly Handmade[] = [],
  ): TopicRecord | null {
    const hand = this.pickHandmade(history, handmade);
    if (hand) return hand;

    const i = history.length;
    const wantBrought = brought.length > 0 && this.rng() < BROUGHT_RATE;
    const type = this.weightedType(history, i);

    const recentPat = new Set(history.slice(-COOL_PATTERN).map((h) => h.patternId));
    const recentEnd = new Set(
      history.slice(-COOL_ENDING).map((h) => h.endingId).filter((x): x is string => !!x),
    );

    let best: (TopicRecord & { score: number }) | null = null;
    for (let m = 0; m < M; m++) {
      const cand = this.tryOne(type, recentPat, recentEnd, history, brought, wantBrought);
      if (!cand) continue;
      const score = nearness(cand, history);
      if (!best || score < best.score) best = { ...cand, score };
    }

    // 型を1つに決めてから引くので、その型の骨格が全部埋まらないと穴が空く。
    // 最後は型をまたいで拾い直す（並べ替えないと id の若い骨格に偏る）
    if (!best) {
      // burned を外してはいけない。全員が「これは違う」と言った骨格が、
      // 型をまたぐ拾い直しの経路から戻ってきていた。
      // クールダウン中の骨格も後回しにする。ここを素通りさせると、
      // 素材が痩せている場面で同じ骨格が2問続けて出る
      const last = history[history.length - 1]?.patternId;
      const usable = this.data.patterns
        .filter((p) => !this.burned.has(p.id))
        .sort(() => this.rng() - 0.5);
      // 直前と同じ骨格は最後の最後まで使わない。ここを素通りさせると、
      // 素材が痩せている場面で同じ骨が2問続けて出る
      const ordered = [
        ...usable.filter((p) => p.id !== last && !recentPat.has(p.id)),
        ...usable.filter((p) => p.id !== last && recentPat.has(p.id)),
        ...usable.filter((p) => p.id === last),
      ];
      for (const pat of ordered) {
        const cand = this.build(pat, recentEnd, brought, false);
        if (cand) { best = { ...cand, score: 0 }; break; }
      }
    }
    if (!best) return null;

    for (const id of best.wordIds) if (!id.startsWith('b-')) this.used.add(id);
    for (const id of best.broughtIds) this.usedBrought.add(id);
    const { score: _score, ...rec } = best;
    return rec;
  }

  /**
   * 手書きお題を出すか決める。
   *
   * 直近3問が続けて引き直されているなら、生成が場と噛み合っていない合図なので
   * 確実に手書きへ落とす（§4.2）。骨格をいじって粘るより確実な札を切る。
   */
  private pickHandmade(
    history: readonly TopicRecord[],
    handmade: readonly Handmade[],
  ): TopicRecord | null {
    const unused = handmade.filter((h) => !this.usedHand.has(h.id));
    if (!unused.length) return null;
    const lastThree = history.slice(-3);
    const stuck = lastThree.length === 3 && lastThree.every((h) => h.discarded);
    if (!stuck && this.rng() >= HANDMADE_RATE) return null;
    // 直前が手書きなら続けない。人の札ばかりだと自動生成の意味がなくなる
    if (!stuck && history[history.length - 1]?.patternId === 'handmade') return null;
    const h = pickFrom(this.rng, unused);
    this.usedHand.add(h.id);
    return {
      id: h.id, text: h.text, patternId: 'handmade', type: 'handmade',
      endingId: null, wordIds: [], tags: [], broughtIds: [], discarded: false,
    };
  }

  private tryOne(
    type: string,
    recentPat: Set<string>,
    recentEnd: Set<string>,
    history: readonly TopicRecord[],
    brought: readonly BroughtWord[],
    wantBrought: boolean,
  ): TopicRecord | null {
    const ofType = this.data.patterns.filter((p) => p.type === type && !this.burned.has(p.id));
    let pats = ofType.filter((p) => !recentPat.has(p.id));
    if (!pats.length) {
      // 骨格の本数が足りない型では、6問のクールダウンを満たせないことがある。
      // それでも**直前と同じ骨格だけは避ける**。2問続けて同じ骨が出ると露骨に見える
      const last = history[history.length - 1]?.patternId;
      pats = ofType.filter((p) => p.id !== last);
      if (!pats.length) pats = ofType;
    }
    if (!pats.length) return null;
    const pat = pickFrom(this.rng, pats);
    return this.build(pat, recentEnd, brought, wantBrought);
  }

  private build(
    pat: Pattern,
    recentEnd: Set<string>,
    brought: readonly BroughtWord[],
    wantBrought: boolean,
  ): TopicRecord | null {
    const es = endingsOf(pat);
    let ending: Ending | null = null;
    if (es.length) {
      const fresh = es.filter((e) => !recentEnd.has(e.id));
      ending = pickFrom(this.rng, fresh.length ? fresh : es);
    }

    const filled = this.fillSlots(pat, ending, brought, wantBrought);
    if (!filled) return null;

    const text = render(pat, filled.chosen, ending);
    if (len(text) > pat.maxLen) return null;

    const words = Object.values(filled.chosen);
    return {
      id: `t-${Math.floor(this.rng() * 1e9).toString(36)}`,
      text,
      patternId: pat.id,
      type: pat.type,
      endingId: ending?.id ?? null,
      wordIds: words.map((w) => w.id),
      tags: [...new Set(words.flatMap((w) => w.tags))],
      broughtIds: filled.brought ? [filled.brought.id] : [],
      discarded: false,
    };
  }

  private available(cat: string): Word[] {
    const all = this.data.pool[cat] ?? [];
    const free = all.filter((w) => !this.used.has(w.id));
    if (free.length) return free;
    for (const w of all) this.used.delete(w.id); // 尽きたら戻す。枯れたことは画面に出さない
    return all;
  }

  private allowed(slot: string, cands: Word[], pat: Pattern, ending: Ending | null): Word[] {
    const deny = pat.deny?.[slot] ?? [];
    // require は骨格にも語尾にも書ける。「何を売っている？」のときだけ sells が要る
    const req = [...(pat.require?.[slot] ?? []), ...(ending?.require?.[slot] ?? [])];
    const denyTags = pat.denyTags?.[slot] ?? [];
    return cands.filter(
      (w) =>
        !w.roles.some((r) => deny.includes(r)) &&
        !w.tags.some((g) => denyTags.includes(g)) &&
        req.every((r) => w.roles.includes(r)),
    );
  }

  private fillSlots(
    pat: Pattern,
    ending: Ending | null,
    brought: readonly BroughtWord[],
    wantBrought: boolean,
  ): { chosen: Record<string, Word>; brought: BroughtWord | null } | null {
    const far = pat.pair === 'far';
    const contentSlots = pat.slots.filter((s) => CONTENT.has(this.data.slotCats[s]));

    for (let attempt = 0; attempt < 40; attempt++) {
      const chosen: Record<string, Word> = {};
      let used: BroughtWord | null = null;

      // 素材の性質に依存する骨格には持ち寄り語を入れない。
      // 諦めるのではなく黙って通常生成に落とす（諦めると穴が空く）
      if (wantBrought && !ending?.noBrought && !pat.noBrought) {
        const free = (s: string) =>
          !pat.deny?.[s]?.length && !pat.require?.[s]?.length &&
          !pat.denyTags?.[s]?.length && !ending?.require?.[s]?.length;
        const cands = brought.filter(
          (b) =>
            !this.usedBrought.has(b.id) &&
            contentSlots.some((s) => this.data.slotCats[s] === b.cat && free(s)),
        );
        if (cands.length) {
          const b = pickFrom(this.rng, cands);
          const slot = pickFrom(
            this.rng,
            contentSlots.filter((s) => this.data.slotCats[s] === b.cat && free(s)),
          );
          chosen[slot] = { id: b.id, word: b.word, cat: b.cat, tags: [], roles: [], level: 1 };
          used = b;
        }
      }

      let ok = true;
      for (const slot of pat.slots) {
        if (chosen[slot]) continue;
        const taken = new Set(Object.values(chosen).map((w) => w.id));
        const cands = this.allowed(slot, this.available(this.data.slotCats[slot]), pat, ending)
          .filter((w) => !taken.has(w.id))
          // 持ち寄り語はタグ条件を免除されるので、相手が非日常だと足場が両方消える
          .filter((w) => !used || !w.tags.includes('非日常'));
        if (!cands.length) { ok = false; break; }
        chosen[slot] = pickFrom(this.rng, cands);
      }
      if (!ok) return null; // 条件を満たす語が無い骨格。引き直しても同じ

      if (contentSlots.length >= 2) {
        // 3つ目以降は「すでに決まったどれか1つ」と噛み合えばよい。
        // 先頭と全部を噛み合わせようとすると条件が厳しすぎて埋まらない
        const done: Word[] = [chosen[contentSlots[0]]];
        let ok2 = true;
        for (const s of contentSlots.slice(1)) {
          const w = chosen[s];
          const isBrought = used?.id === w.id;
          if (isBrought || done.some((p) => used?.id === p.id || pairOk(p, w, far))) {
            done.push(w);
            continue;
          }
          ok2 = false;
          break;
        }
        if (!ok2) continue;
      }
      return { chosen, brought: used };
    }
    return null;
  }

  private weightedType(history: readonly TopicRecord[], i: number): string {
    const lastAt: Record<string, number> = {};
    history.forEach((h, idx) => {
      // 引き直された型は減衰を6問ぶんに伸ばす（§4.2）
      lastAt[h.type] = h.discarded ? idx + 3 : idx;
    });
    const entries = Object.entries(WEIGHTS)
      .map(([t, w]) => {
        const d = i - (lastAt[t] ?? -99);
        return [t, w * (TYPE_DECAY[d] ?? 1)] as const;
      })
      .filter(([, w]) => w > 0);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.rng() * total;
    for (const [t, w] of entries) {
      r -= w;
      if (r <= 0) return t;
    }
    return entries[entries.length - 1][0];
  }
}

function render(pat: Pattern, chosen: Record<string, Word>, ending: Ending | null): string {
  // 語尾が素材語をそのまま繰り返すと、語が長いとき狭く不格好になる。
  // 6文字以上なら fallback（「どんなの？」）へ落とす
  let tail = ending?.text ?? '';
  if (ending?.fallback) {
    const long = Object.entries(chosen).some(
      ([s, w]) => tail.includes(`{${s}}`) && len(w.word) >= 6,
    );
    if (long) tail = ending.fallback;
  }
  let text = pat.template.replace('{E}', tail);
  for (const [slot, w] of Object.entries(chosen)) text = text.replaceAll(`{${slot}}`, w.word);
  return text.replace(/\{[A-Z0-9]+\}/g, '').trim(); // 付かなかったスロットを消す
}

/** 直近K問との「近さ」。小さいほど新鮮（§4.1） */
function nearness(cand: TopicRecord, history: readonly TopicRecord[]): number {
  let score = 0;
  for (const h of history.slice(-K)) {
    const mult = h.discarded ? 2 : 1;
    if (h.type === cand.type) score += NEAR_TYPE * mult;
    if (h.patternId === cand.patternId) score += 4 * mult;
    if (h.endingId && h.endingId === cand.endingId) score += 3 * mult;
    for (const id of cand.wordIds) if (h.wordIds.includes(id)) score += 2 * mult;
    for (const t of cand.tags) if (h.tags.includes(t)) score += mult;
  }
  return score;
}

/** シード付き乱数。シードはサーバーだけが持つ（SPEC.md §8.4） */
export function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
