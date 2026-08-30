import { FLIP_H, FLIP_W, type BroughtWord, type Flip } from '../engine/types';

/**
 * Socket.IO のイベント名。サーバーとクライアントの両方がここから読む。
 *
 * 文字列を両側にべた書きすると、片方だけ書き換えたときに何も起きなくなる。
 * 型エラーにもテスト失敗にもならず、ボタンが黙って効かなくなるだけなので
 * 気づくのが遅れる。ranking-tote / senryu-game で一度それをやっている。
 */
export const EV = {
  create: 'room:create',
  join: 'room:join',
  rejoin: 'room:rejoin',
  leave: 'room:leave',
  /** 持ち寄り語を足す／消す（ロビーにいる間だけ） */
  word: 'room:word',
  /** 手書きお題を投稿する／消す（TOPIC-GEN.md §9.1） */
  topic: 'room:topic',
  start: 'host:start',
  kick: 'host:kick',
  toLobby: 'host:toLobby',
  action: 'game:action',
  state: 'state',
} as const;

export type EventName = (typeof EV)[keyof typeof EV];

// --- 入力の検証（SPEC.md §4.4 / §9.2）。クライアントのボタン制御は見た目でしかない ---

export const LIMIT = {
  name: 12,
  strokes: 2000,
  points: 40000,
  texts: 10,
  textLen: 60,
  wordLen: 12,
  wordsPerPlayer: 3,
  topicMin: 4,
  topicMax: 60,
  topicsPerPlayer: 5,
} as const;

export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, LIMIT.name);
  return t.length ? t : null;
}

const finiteIn = (n: unknown, max: number) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;

/**
 * 上限に引っかかったら拒否する。座標を勝手に丸めて通すと、
 * 書いた本人の画面と場に出る絵が食い違う。
 */
export function checkFlip(v: unknown): Flip | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Flip;
  if (!Array.isArray(f.strokes) || !Array.isArray(f.texts)) return null;
  if (f.strokes.length > LIMIT.strokes || f.texts.length > LIMIT.texts) return null;

  let total = 0;
  for (const s of f.strokes) {
    if (!s || !Array.isArray(s.points) || s.points.length < 2 || s.points.length % 2 !== 0) return null;
    if (!['black', 'red', 'blue'].includes(s.color)) return null;
    if (![1, 2, 3].includes(s.width)) return null;
    total += s.points.length / 2;
    if (total > LIMIT.points) return null;
    for (let i = 0; i < s.points.length; i += 2) {
      if (!finiteIn(s.points[i], FLIP_W) || !finiteIn(s.points[i + 1], FLIP_H)) return null;
    }
  }
  for (const t of f.texts) {
    if (!t || typeof t.text !== 'string') return null;
    if (!t.text.trim() || Array.from(t.text).length > LIMIT.textLen) return null;
    if (!finiteIn(t.x, FLIP_W) || !finiteIn(t.y, FLIP_H)) return null;
    if (![1, 2, 3].includes(t.size)) return null;
  }
  return { strokes: f.strokes, texts: f.texts };
}

const CATS = ['person', 'place', 'act'] as const;

export function checkWord(word: unknown, cat: unknown): Pick<BroughtWord, 'word' | 'cat'> | null {
  if (typeof word !== 'string') return null;
  const w = word.trim();
  if (!w.length || Array.from(w).length > LIMIT.wordLen) return null;
  if (!CATS.includes(cat as (typeof CATS)[number])) return null;
  return { word: w, cat: cat as BroughtWord['cat'] };
}

/**
 * 投稿された手書きお題。上限だけ見る。面白いかどうかは人が判断する
 * （出てきたお題が外れなら、全員で引き直せばいい）
 */
export function checkTopicText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  const n = Array.from(t).length;
  return n >= LIMIT.topicMin && n <= LIMIT.topicMax ? t : null;
}

/** 持ち寄り語の種類。ロビーの4択と、生成側の cat を1箇所で対応させる */
export const CAT_LABEL: Record<BroughtWord['cat'], string> = {
  person: 'だれ',
  place: 'どこ',
  act: 'すること',
};
