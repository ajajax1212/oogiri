/**
 * ゲームのルールが扱う型。ここに React も Socket.IO も持ち込まない。
 * 純粋に保っておくと、reducer をそのままテストできる。
 */

// --- フリップ（SPEC.md §4） ---

/** 論理座標。表示側は CSS で縮めるだけにする */
export const FLIP_W = 1600;
export const FLIP_H = 1000;

export type StrokeColor = 'black' | 'red' | 'blue';

export type Stroke = {
  color: StrokeColor;
  width: 1 | 2 | 3;
  /** [x0,y0,x1,y1,...] 論理座標 */
  points: number[];
};

export type TextItem = {
  text: string;
  x: number;
  y: number;
  size: 1 | 2 | 3;
};

export type Flip = {
  strokes: Stroke[];
  texts: TextItem[];
};

export const emptyFlip = (): Flip => ({ strokes: [], texts: [] });

export const flipIsEmpty = (f: Flip): boolean =>
  f.strokes.length === 0 && f.texts.length === 0;

// --- お題（TOPIC-GEN.md） ---

export type Topic = { id: string; text: string };

/** 生成の内訳。次のお題を計算されるので viewFor では落とす */
export type TopicRecord = Topic & {
  patternId: string;
  type: string;
  endingId: string | null;
  wordIds: string[];
  tags: string[];
  broughtIds: string[];
  discarded: boolean;
};

/** ロビーで各自が入れる単語（SPEC.md §9.2） */
export type BroughtWord = {
  id: string;
  word: string;
  /** 「なに」は無い。物の持ち寄りは事故が多かったので落とした（TOPIC-GEN.md §5.1） */
  cat: 'person' | 'place' | 'act';
  /** 誰が入れたかは画面に出さないが、本人が消せるように持つ */
  byId: string;
};

/** 参加者が書いて投稿したお題（TOPIC-GEN.md §9.1）。自動生成に混ざって出る */
export type Handmade = {
  id: string;
  text: string;
  /** 誰が出したかは画面に出さない。本人が消せるようにだけ持つ */
  byId: string;
};

// --- 採点（SPEC.md §6） ---

export type Score = 1 | 2 | 3;
export type Verdict = 'small' | 'medium' | 'big' | 'perfect' | 'none';

export type Tally = {
  verdict: Verdict;
  /** 内訳の分布。誰が押したかは持たない */
  counts: { 1: number; 2: number; 3: number };
  judges: number;
};

// --- 部屋とお題セッション ---

export type RoomPhase = 'lobby' | 'live';
export type TopicPhase = 'intro' | 'open' | 'declared' | 'stage' | 'reveal' | 'tally' | 'result';

export type Player = {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  /** 満点大笑いの回数。これ以外の得点は持たない（SPEC.md §6.6） */
  perfects: number;
  /** 合意ボタンを押しているか（SPEC.md §7） */
  ready: boolean;
  /** フリップを書いている最中か。中身は配らない（SPEC.md §4.5） */
  writing: boolean;
};

/** 進行中の1回答 */
export type Answer = {
  playerId: string;
  flip: Flip;
  /** playerId -> Score。誰が何を押したかは viewFor で落とす */
  scores: Record<string, Score>;
  tally: Tally | null;
};

export type GameState = {
  roomPhase: RoomPhase;
  players: Player[];
  /** 座席順。players 自体は絶対に並べ替えない（p0..pn と対応するため） */
  topic: Topic | null;
  topicPhase: TopicPhase;
  /** そのお題で公開された回答の数。0 ならボタンは「引き直す」（SPEC.md §7.1） */
  revealedCount: number;
  answer: Answer | null;
  /** サーバーが持つ時計の絶対時刻。クライアントは残りを描くだけ */
  deadline: number | null;
  brought: BroughtWord[];
  handmade: Handmade[];
  /** 生成の履歴。viewFor では丸ごと落とす */
  history: TopicRecord[];
};

// --- 行動（SPEC.md §8.2） ---

export type Action =
  | { type: 'ANSWER_CLAIM'; playerId: string; flip: Flip }
  | { type: 'ANSWER_REVEAL'; playerId: string }
  | { type: 'SCORE'; playerId: string; value: Score }
  | { type: 'NEXT_READY'; playerId: string; ready: boolean }
  | { type: 'WRITING'; playerId: string; writing: boolean }
  /** サーバーのタイマーが打つ。クライアントからは送れない */
  | { type: 'TICK'; now: number }
  /** 切断が続いた回答者から回答権を取り上げる */
  | { type: 'RELEASE_CLAIM' };
