import { DELAY } from '../engine/reducer';
import type { Verdict } from '../engine/types';

/**
 * 決着の段取り（SPEC.md §6・§10.2）。
 *
 * `tally` と `result` を1つの画面として扱い、**フリップの周りを金の枠が
 * 段階的に囲っていく**。どこまで来たかがそのまま判定になる。
 *
 * **画と音の両方がこの1つの関数から時刻を読む。** 別々に計算すると必ずずれて、
 * 枠が閉じ切る前に大笑いの声が鳴る（＝ネタバレ）。
 */

/** 枠の段数。12段で閉じ切る */
export const RUNGS = 12;

/** 判定 → 止まる段。**この対応が判定の表示そのもの**（SPEC.md §6.4 の4段と1対1） */
export const STOP_AT: Record<Verdict, number> = {
  none: 0,
  small: 3,
  medium: 6,
  big: 9,
  perfect: RUNGS,
};

/**
 * 使える時間。サーバーの `DELAY` から出す（engine は読むだけ・書き換えない）。
 * tally 1.2秒 + result 4.5秒 = 5.7秒。この中に溜めと判定の表示が両方入る。
 */
export const BUDGET = DELAY.tally + DELAY.result;

/**
 * 判定を読ませる最低時間。溜めがこれを食い潰さないよう頭を押さえる。
 *
 * **数字は「読む」ではなく「聞き終わる」で決まっている。** 判定の音源
 * （public/sfx の small/medium/big/perfect）は実測 3.57〜3.70 秒あり、いちばん長い
 * perfect が 3.70 秒。ここが短いと、笑い声が鳴り終わる前に result が open へ移り、
 * 書きかけ用の白いフリップが音の尻に被る（実際にそう言われた）。
 * 3700 にすると溜めの上限は BUDGET − 3700 = 2000ms になり、
 * どの判定でも「音が鳴り終わってから次の場面」の順序が保証される。
 *
 * **音源を差し替えて長さが変わったら、ここも測り直す。**
 * （sound.ts の `dur` は合成音の長さで、音源ファイルの長さではない）
 */
export const READ_MIN = 3700;

/**
 * 尺の表。**数字はここだけを触れば変わる。**
 *
 * `build` … 枠が動き出してから判定の文字と音が出るまで（＝溜め全体）の下限と上限。
 *           実際の値はこの範囲を決定的乱数で1点選ぶ。
 * `hold`  … 最後の一段が止まってから判定が出るまでの間。`build` の内数。
 *           「止まった…けどもう一段来るのでは？」を作る沈黙なので、
 *           下の判定へ落ちる中・大ほど長く取ってある。
 * `pause` … 3/6/9段目（＝1つ下の判定の境目）を越えるときだけ足踏みする倍率。
 *           ここで止まって見せるのが「もしかして大笑いか…？」の正体。
 * `tail`  … 最後の一段だけ手前を長く取る倍率。到着を溜める。
 * `flat`  … true なら足踏みも溜めもせず等間隔。矢継ぎ早に閉じるとき用。
 */
type Tune = {
  build: readonly [number, number];
  hold: number;
  pause: number;
  tail: number;
  flat?: boolean;
};

/** `perfect` だけ「採点が速かった」用の別行を持つ。他の判定に速い遅いは付けない */
type TuneKey = Verdict | 'rush';

/**
 * **溜めの天井は READ_MIN が決めている（BUDGET − READ_MIN = 2000ms）。**
 * `build` にそれより大きい数を書いても closingPlan が刈り取るので、
 * ここには刈られない範囲の数字だけを書く。判定ごとの差は「全体の長さ」ではなく
 * **段の刻み方**（`pause` の足踏みと `hold` の沈黙）で出す。
 */
export const TUNE: Record<TuneKey, Tune> = {
  // 採点者が居なかった回答。動く段が無いので、間だけ取ってすぐ「判定なし」を出す。
  // ここだけは音が鳴らないので、READ_MIN に合わせて長く取る理由が無い
  none: { build: [700, 700], hold: 600, pause: 1, tail: 1, flat: true },
  // 3段で終わるのをサクサク出すと気の毒なので、**最低でも2秒**は使う（本人の指定）。
  // 天井もちょうど2秒なので、小笑いだけは常にこの長さになる
  small: { build: [2000, 2000], hold: 300, pause: 1.8, tail: 1.35 },
  // 3段で止まって見せてから6段目まで。止まった後も「9段目が来るのでは」の間を残す
  medium: { build: [1750, 1950], hold: 340, pause: 2.2, tail: 1.3 },
  // 3段・6段の2回足踏みする。**回数は減らさず、1回あたりを短くした**
  big: { build: [1800, 1950], hold: 340, pause: 2.2, tail: 1.3 },
  // 9段で一度止まって見せてから閉じ切る。閉じ切った先に全画面の演出が来る。
  // 天井を 2000 ではなく 1900 にしてあるのは、判定の音がいちばん長い（3.70秒）から。
  // 天井いっぱいだと音の終わりと open がちょうど同時になって余裕が無くなる
  perfect: { build: [1850, 1900], hold: 320, pause: 2.2, tail: 1.25 },
  // 採点が速く、明らかに満点だった場合。足踏みを消して一気に閉じる
  rush: { build: [900, 1200], hold: 200, pause: 1, tail: 1, flat: true },
};

/**
 * 「採点が速かった」の閾値。
 *
 * サーバーは経過時間を配らないので、クライアントが `reveal` に入ってから
 * `tally` に入るまでを測る。**この区間はサーバーが phase を配った時刻で
 * 決まる**ので、同じ部屋の全員がほぼ同じ値を得る（各自のタップの速さではない）。
 *
 * 下駄の 800ms は、板が止まるまで採点ボタンが押せない分（styles.css の showup が
 * 0.72 秒）。これを引かないと、人数が少ないときに永久に「速い」にならない。
 */
const RUSH_BASE = 800;
const RUSH_PER_JUDGE = 1400;

export function isRush(elapsedMs: number | null, judges: number): boolean {
  // **測れなかったら必ず「普通」に落とす。** 途中から入った人は reveal を見ていない。
  // ここで NaN や 0 を「速い」と読むと、その人の画面だけ矢継ぎ早になる
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return false;
  if (judges <= 0) return false;
  return elapsedMs <= RUSH_BASE + RUSH_PER_JUDGE * judges;
}

/* ---------------------------------------------------------------- 決定的乱数 */

/**
 * **各画面が Math.random() を呼んではいけない。** 同じ部屋の全員が同じ絵を
 * 見ている前提のゲームなので、人によって判定の出る瞬間がずれる。
 * 回答者の id・お題の id・判定から種を作り、同じ回答なら誰の画面でも同じ間で止める。
 */
export function seedOf(playerId: string, topicId: string | null, verdict: Verdict): string {
  return `${playerId}|${topicId ?? '-'}|${verdict}`;
}

/** FNV-1a。短い文字列から素直に散る 32bit が要るだけなので自前で持つ（依存を増やさない） */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32。種1つから同じ列が出れば足りる */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- 段取り */

export type ClosingPlan = {
  /** 止まる段（＝判定） */
  stop: number;
  /** 各段が止まる時刻。枠が動き出した瞬間からの ms。長さは stop と同じ */
  at: number[];
  /** 判定の文字と音を出す時刻（ms）。画と音はどちらもここを見る */
  verdictAt: number;
  /** 判定が映っている長さ（ms）。尺を机上で確かめるために持つ */
  readMs: number;
};

export function closingPlan(o: {
  verdict: Verdict;
  seed: string;
  rush: boolean;
  /** 動きを畳む。長さだけでなく遅延も 0 にする（判定は即座に伝える） */
  reduced: boolean;
}): ClosingPlan {
  const stop = STOP_AT[o.verdict];

  if (o.reduced) {
    // 遅延を残すと、動かないまま何秒も判定が出てこない画面になる。
    // 伝えるべきは「何笑いか」なので、そこだけ即座に出す
    return { stop, at: new Array<number>(stop).fill(0), verdictAt: 0, readMs: BUDGET };
  }

  const t = TUNE[o.verdict === 'perfect' && o.rush ? 'rush' : o.verdict];
  const rand = rngOf(hash32(o.seed));

  // 溜めの上限は「使える時間 − 判定を読む最低時間」。ここを外すと
  // 枠が閉じたのと同時に画面が次へ行って、判定が読めない
  const span = t.build[1] - t.build[0];
  const build = Math.min(BUDGET - READ_MIN, Math.round(t.build[0] + span * rand()));

  const at: number[] = [];
  if (stop > 0) {
    const w: number[] = [];
    for (let i = 1; i <= stop; i += 1) {
      let x = 1;
      // i 段目へ動く手前。i-1 が 3/6/9 なら、そこは1つ下の判定の境目
      if (!t.flat && i > 1 && (i - 1) % 3 === 0) x *= t.pause;
      if (!t.flat && i === stop) x *= t.tail;
      // ばらつき。同じ判定でも毎回同じリズムだと、2問目から先が読める
      x *= 0.84 + rand() * 0.32;
      w.push(x);
    }
    const sum = w.reduce((a, b) => a + b, 0);
    const moving = Math.max(0, build - t.hold);
    let acc = 0;
    for (const x of w) {
      acc += (moving * x) / sum;
      at.push(Math.round(acc));
    }
  }

  return { stop, at, verdictAt: build, readMs: BUDGET - build };
}

/** 途中から入った人のために、経過 ms の時点で既に上がっている段数を返す */
export function stepAt(plan: ClosingPlan, elapsed: number): number {
  let n = 0;
  for (const ms of plan.at) if (ms <= elapsed) n += 1;
  return n;
}

/** 動きを嫌う設定。判定の遅延もここで畳むので、画面側と音側で二重に見ない */
export function prefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
