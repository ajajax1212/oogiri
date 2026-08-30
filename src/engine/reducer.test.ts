import { describe, expect, it } from 'vitest';
import { createGame, DELAY, reduce, start, startTopic, toLobby, type Ctx } from './reducer';
import type { Action, Flip, GameState, Player, TopicRecord } from './types';

/**
 * ルールの本体（SPEC.md §5〜§7）。
 *
 * お題の生成は ctx で差し替える。ここで本物の生成器を使うと、
 * 落ちたときにルールが悪いのか素材が悪いのか分からなくなる。
 */

let topicNo = 0;
const rec = (): TopicRecord => ({
  id: `t${++topicNo}`, text: `お題${topicNo}`, patternId: `p${topicNo}`, type: 'attr',
  endingId: null, wordIds: [], tags: [], broughtIds: [], discarded: false,
});

const burned: TopicRecord[] = [];
const ctx = (now = 1000): Ctx => ({
  now,
  nextTopic: () => rec(),
  burnTopic: (r) => { burned.push(r); },
});

const player = (id: string, over: Partial<Player> = {}): Player => ({
  id, name: id, isHost: id === 'p0', connected: true, perfects: 0, ready: false, writing: false, ...over,
});

const drawn: Flip = { strokes: [{ color: 'black', width: 2, points: [0, 0, 10, 10] }], texts: [] };

function live(ids: string[], over: Partial<GameState> = {}): GameState {
  const started = start({ ...createGame(), players: ids.map((i) => player(i)) }, ctx());
  // 新しいお題はまず intro（全画面表示）。ボードに触れる open まで進めてから渡す
  const s = reduce(started, { type: 'TICK', now: 9e9 }, ctx(9e9));
  return { ...s, ...over };
}

const run = (s: GameState, a: Action, now = 1000) => reduce(s, a, ctx(now));

describe('お題の全画面表示', () => {
  it('新しいお題はまず intro で出て、数秒後にボード（open）へ移る', () => {
    const s = start({ ...createGame(), players: [player('p0'), player('p1')] }, ctx(1000));
    expect(s.topicPhase).toBe('intro');
    expect(s.deadline).toBe(1000 + DELAY.intro);
    // 時間が来るまでは動かない。クライアント側のタイマーで進めてはいけない
    expect(reduce(s, { type: 'TICK', now: 1000 + DELAY.intro - 1 }, ctx()).topicPhase).toBe('intro');
    expect(reduce(s, { type: 'TICK', now: 1000 + DELAY.intro }, ctx()).topicPhase).toBe('open');
  });

  it('intro のあいだは回答できない', () => {
    const s = start({ ...createGame(), players: [player('p0'), player('p1')] }, ctx());
    expect(run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn })).toBe(s);
  });
});

describe('回答権', () => {
  it('先着1人だけが通る', () => {
    const s = live(['p0', 'p1', 'p2']);
    const a = run(s, { type: 'ANSWER_CLAIM', playerId: 'p1', flip: drawn });
    expect(a.answer?.playerId).toBe('p1');
    expect(a.topicPhase).toBe('declared');

    // 2人目は弾かれ、状態は1ミリも動かない
    const b = run(a, { type: 'ANSWER_CLAIM', playerId: 'p2', flip: drawn });
    expect(b).toBe(a);
  });

  it('空のフリップでは回答できない（ボタンの無効化は通信を叩けば素通りする）', () => {
    const s = live(['p0', 'p1']);
    const a = run(s, { type: 'ANSWER_CLAIM', playerId: 'p1', flip: { strokes: [], texts: [] } });
    expect(a).toBe(s);
  });

  it('回答すると、その人の「次へ」の印が自動的に外れる', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(s.players.find((p) => p.id === 'p1')?.ready).toBe(true);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p1', flip: drawn });
    expect(s.players.find((p) => p.id === 'p1')?.ready).toBe(false);
  });

  it('宣言は2.0秒でお題の再表示へ移る', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p1', flip: drawn }, 1000);
    expect(s.deadline).toBe(1000 + DELAY.declared);
    expect(run(s, { type: 'TICK', now: 2999 }, 2999).topicPhase).toBe('declared');
    expect(run(s, { type: 'TICK', now: 3000 }, 3000).topicPhase).toBe('stage');
  });

  it('回答者以外は公開できない', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p1', flip: drawn });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    expect(s.topicPhase).toBe('stage');
    expect(run(s, { type: 'ANSWER_REVEAL', playerId: 'p0' })).toBe(s);
    expect(run(s, { type: 'ANSWER_REVEAL', playerId: 'p1' }).topicPhase).toBe('reveal');
  });
});

describe('採点', () => {
  const reveal = (ids: string[]) => {
    let s = live(ids);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    return run(s, { type: 'ANSWER_REVEAL', playerId: 'p0' });
  };

  it('回答者は自分の回答を採点できない', () => {
    const s = reveal(['p0', 'p1', 'p2']);
    expect(run(s, { type: 'SCORE', playerId: 'p0', value: 3 })).toBe(s);
  });

  it('1人1回。2度目は通らない', () => {
    let s = reveal(['p0', 'p1', 'p2']);
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 1 });
    const again = run(s, { type: 'SCORE', playerId: 'p1', value: 3 });
    expect(again).toBe(s);
    expect(s.answer?.scores.p1).toBe(1);
  });

  it('採点者が全員押した瞬間に確定する', () => {
    let s = reveal(['p0', 'p1', 'p2']);
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 3 });
    expect(s.topicPhase).toBe('reveal'); // まだ p2 が残っている
    s = run(s, { type: 'SCORE', playerId: 'p2', value: 3 });
    expect(s.topicPhase).toBe('tally');
    expect(s.answer?.tally?.verdict).toBe('perfect');
  });

  it('満点大笑いのときだけ回答者の回数が増える', () => {
    let s = reveal(['p0', 'p1']);
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 3 });
    expect(s.players.find((p) => p.id === 'p0')?.perfects).toBe(1);

    let t = reveal(['p0', 'p1']);
    t = run(t, { type: 'SCORE', playerId: 'p1', value: 2 });
    expect(t.players.find((p) => p.id === 'p0')?.perfects).toBe(0);
  });

  it('切断した人は必要人数から外れ、残り全員で確定する', () => {
    let s = reveal(['p0', 'p1', 'p2']);
    s = { ...s, players: s.players.map((p) => (p.id === 'p2' ? { ...p, connected: false } : p)) };
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 2 });
    expect(s.topicPhase).toBe('tally');
    expect(s.answer?.tally?.judges).toBe(1);
  });

  it('押したあとに切断しても、その票は残る', () => {
    // 採点者が p1 だけになる並びにする。p2 を残すと「p2 がまだ押していない」で正しく止まる
    let s = reveal(['p0', 'p1']);
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 3 });
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, connected: false } : p)) };
    s = run(s, { type: 'TICK', now: 1 }, 1); // 切断を受けて条件を測り直す
    expect(s.topicPhase).toBe('tally');
    expect(s.answer?.tally?.counts).toEqual({ 1: 0, 2: 0, 3: 1 });
  });
});

describe('次のお題に行く / 引き直す', () => {
  it('全員が押すまで進まない', () => {
    let s = live(['p0', 'p1']);
    const first = s.topic?.id;
    s = run(s, { type: 'NEXT_READY', playerId: 'p0', ready: true });
    expect(s.topic?.id).toBe(first);
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(s.topic?.id).not.toBe(first);
  });

  it('切断中の人は人数から外す（1人落ちても進める）', () => {
    let s = live(['p0', 'p1', 'p2']);
    s = { ...s, players: s.players.map((p) => (p.id === 'p2' ? { ...p, connected: false } : p)) };
    const first = s.topic?.id;
    s = run(s, { type: 'NEXT_READY', playerId: 'p0', ready: true });
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(s.topic?.id).not.toBe(first);
  });

  it('回答が進行中なら、全員が押しても進まない', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    const topic = s.topic?.id;
    s = run(s, { type: 'NEXT_READY', playerId: 'p0', ready: true });
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(s.topicPhase).toBe('declared');
    expect(s.topic?.id).toBe(topic);
  });

  it('判定が終わって open に戻った瞬間に、溜まっていた合意で進む', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    s = run(s, { type: 'ANSWER_REVEAL', playerId: 'p0' });
    const topic = s.topic?.id;
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 2 });   // → tally
    s = run(s, { type: 'NEXT_READY', playerId: 'p0', ready: true });
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(s.topic?.id).toBe(topic);
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);       // tally → result
    s = run(s, { type: 'TICK', now: 9e9 + 1e5 }, 9e9);  // result → open → 進む
    expect(s.topic?.id).not.toBe(topic);
  });

  it('最初の回答が公開された瞬間に、全員の印が外れる', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    s = run(s, { type: 'ANSWER_REVEAL', playerId: 'p0' });
    expect(s.players.every((p) => !p.ready)).toBe(true);
    expect(s.revealedCount).toBe(1);
  });

  it('回答0件のまま全員が押したら、そのお題は引き直しとして記録される', () => {
    burned.length = 0;
    let s = live(['p0', 'p1']);
    const first = s.history[0];
    s = run(s, { type: 'NEXT_READY', playerId: 'p0', ready: true });
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(first.discarded).toBe(true);
    expect(burned).toContain(first);
  });

  it('回答が出たあとの「次へ」は引き直しにならない', () => {
    burned.length = 0;
    let s = live(['p0', 'p1']);
    const first = s.history[0];
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    s = run(s, { type: 'ANSWER_REVEAL', playerId: 'p0' });
    s = run(s, { type: 'SCORE', playerId: 'p1', value: 2 });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    s = run(s, { type: 'NEXT_READY', playerId: 'p0', ready: true });
    s = run(s, { type: 'NEXT_READY', playerId: 'p1', ready: true });
    expect(first.discarded).toBe(false);
    expect(burned).toHaveLength(0);
  });

  it('新しいお題では印が解除され、回答数も戻る', () => {
    let s = live(['p0', 'p1'], { revealedCount: 3 });
    s = startTopic(s, ctx());
    expect(s.topicPhase).toBe('intro');
    expect(s.revealedCount).toBe(0);
    expect(s.players.every((p) => !p.ready && !p.writing)).toBe(true);
  });
});

describe('回答者の切断', () => {
  it('宣言・再表示の間に切れたら回答権を解放して open に戻る', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    s = run(s, { type: 'RELEASE_CLAIM' });
    expect(s.answer).toBeNull();
    expect(s.topicPhase).toBe('open');
  });

  it('公開まで進んでいれば解放しない（すでに全員が見ている）', () => {
    let s = live(['p0', 'p1']);
    s = run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn });
    s = run(s, { type: 'TICK', now: 9e9 }, 9e9);
    s = run(s, { type: 'ANSWER_REVEAL', playerId: 'p0' });
    expect(run(s, { type: 'RELEASE_CLAIM' })).toBe(s);
  });
});

describe('ロビーへ戻す', () => {
  it('満点回数はリセットし、持ち寄り語と投稿されたお題は残す', () => {
    const s: GameState = {
      ...live(['p0', 'p1']),
      players: [player('p0', { perfects: 2 }), player('p1', { perfects: 1 })],
      brought: [{ id: 'b1', word: 'たけし', cat: 'person', byId: 'p0' }],
      handmade: [{ id: 'h1', text: 'こんな朝は嫌だ。どんなの？', byId: 'p1' }],
    };
    const back = toLobby(s);
    expect(back.players.every((p) => p.perfects === 0)).toBe(true);
    expect(back.brought).toHaveLength(1);
    expect(back.handmade).toHaveLength(1);
    expect(back.roomPhase).toBe('lobby');
  });

  it('ロビーにいる間はゲームの行動を受け付けない', () => {
    const s = createGame();
    expect(run(s, { type: 'ANSWER_CLAIM', playerId: 'p0', flip: drawn })).toBe(s);
  });
});
