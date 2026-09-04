import { describe, expect, it } from 'vitest';
import { createGame } from './reducer';
import { viewFor } from './view';
import type { Flip, GameState, TopicRecord } from './types';

/**
 * 1人分に絞った状態（SPEC.md §8.4）。
 *
 * ここは「配らないこと」を確かめるテストなので、
 * JSON にしてから文字列で探す。将来ネストが増えても漏れを拾える。
 */

const flip: Flip = {
  strokes: [],
  texts: [{ text: 'ここに答え', x: 800, y: 500, w: 900, size: 120, font: 'gothic', rot: 0, align: 'center' }],
};

const rec: TopicRecord = {
  id: 't1', text: 'お題', patternId: 'at-01', type: 'attr', endingId: 'at-01#0',
  wordIds: ['pe-01', 'or-11'], tags: ['職場'], broughtIds: ['b1'], discarded: false,
};

const base = (over: Partial<GameState> = {}): GameState => ({
  ...createGame(),
  roomPhase: 'live',
  players: [
    { id: 'p0', name: 'たろう', isHost: true, connected: true, perfects: 1, ready: false, writing: true },
    { id: 'p1', name: 'じろう', isHost: false, connected: true, perfects: 0, ready: true, writing: false },
    { id: 'p2', name: 'さぶろう', isHost: false, connected: false, perfects: 0, ready: false, writing: false },
  ],
  topic: { id: 't1', text: 'お題' },
  history: [rec],
  ...over,
});

const json = (s: GameState, me: string) => JSON.stringify(viewFor(s, 'ABCD', me));

describe('viewFor が落とすもの', () => {
  it('生成の内訳（骨格・語尾・素材）を配らない', () => {
    const j = json(base(), 'p0');
    expect(j).not.toContain('at-01');
    expect(j).not.toContain('pe-01');
    expect(j).not.toContain('patternId');
    expect(j).not.toContain('history');
  });

  it('公開前のフリップは回答者本人にだけ配る', () => {
    const s = base({
      topicPhase: 'stage',
      answer: { playerId: 'p0', flip, scores: {}, tally: null },
    });
    expect(json(s, 'p0')).toContain('ここに答え');
    expect(json(s, 'p1')).not.toContain('ここに答え');
    expect(viewFor(s, 'ABCD', 'p1').answer?.flip).toBeNull();
  });

  it('公開後は全員に配る', () => {
    const s = base({
      topicPhase: 'reveal',
      answer: { playerId: 'p0', flip, scores: {}, tally: null },
    });
    expect(json(s, 'p1')).toContain('ここに答え');
  });

  it('誰が何点を押したかは配らない。人数だけ', () => {
    const s = base({
      topicPhase: 'reveal',
      answer: { playerId: 'p0', flip, scores: { p1: 3 }, tally: null },
    });
    const v = viewFor(s, 'ABCD', 'p1');
    expect(v.answer?.scored).toBe(1);
    expect(v.answer?.iScored).toBe(true);
    expect(viewFor(s, 'ABCD', 'p0').answer?.iScored).toBe(false);
    expect(json(s, 'p0')).not.toContain('"p1":3');
  });

  it('他人が投稿したお題の本文は配らない', () => {
    const s = base({
      handmade: [
        { id: 'h1', text: '自分が出したお題', byId: 'p0' },
        { id: 'h2', text: '他人が出したお題', byId: 'p1' },
      ],
    });
    const j = json(s, 'p0');
    expect(j).toContain('自分が出したお題');
    expect(j).not.toContain('他人が出したお題');
    expect(viewFor(s, 'ABCD', 'p0').handmadeCount).toBe(2);
  });
});

describe('viewFor が配るもの', () => {
  it('宣言の間はお題の文を伏せるが、識別子は配る', () => {
    // 識別子を配らないと、クライアントが「お題が変わった」を文で判定してしまい、
    // 誰かが回答するたびに全員の書きかけが消える（一度これで壊した）
    const s = base({ topicPhase: 'declared' });
    const v = viewFor(s, 'ABCD', 'p1');
    expect(v.topic).toBeNull();
    expect(v.topicId).toBe('t1');
  });

  it('合意ボタンのラベルは、回答が公開されたかで変わる', () => {
    expect(viewFor(base(), 'ABCD', 'p0').agree).toBe('reroll');
    expect(viewFor(base({ revealedCount: 1 }), 'ABCD', 'p0').agree).toBe('next');
  });

  it('人数は接続中だけで数える', () => {
    const v = viewFor(base(), 'ABCD', 'p0');
    expect(v.aliveCount).toBe(2); // p2 は切断中
    expect(v.readyCount).toBe(1);
  });

  it('採点者の数は回答者を除いた接続中の人数', () => {
    const s = base({ topicPhase: 'reveal', answer: { playerId: 'p0', flip, scores: {}, tally: null } });
    expect(viewFor(s, 'ABCD', 'p1').answer?.judges).toBe(1); // p1 だけ（p2 は切断中）
  });

  it('書いているかどうかは配るが、中身は配らない', () => {
    const v = viewFor(base(), 'ABCD', 'p1');
    expect(v.players.find((p) => p.id === 'p0')?.writing).toBe(true);
  });

  it('持ち寄り語は全員に見せるが、誰が入れたかは出さない', () => {
    const s = base({ brought: [{ id: 'b1', word: 'たけし', cat: 'person', byId: 'p0' }] });
    const v = viewFor(s, 'ABCD', 'p1');
    expect(v.brought[0].word).toBe('たけし');
    expect(v.brought[0].mine).toBe(false);
    expect(json(s, 'p1')).not.toContain('byId');
  });
});

describe('flipKey（同じフリップを二度送らないための鍵）', () => {
  const drawn = { strokes: [{ color: 'black' as const, width: 2 as const, points: [0, 0, 10, 10] }], texts: [] };

  it('公開前は本人にだけ鍵が付き、他人には付かない', () => {
    const s = base({ topicPhase: 'stage', answer: { playerId: 'p1', flip: drawn, scores: {}, tally: null } });
    expect(viewFor(s, 'ABCD', 'p1').answer?.flipKey).not.toBeNull();
    expect(viewFor(s, 'ABCD', 'p0').answer?.flipKey).toBeNull();
    expect(viewFor(s, 'ABCD', 'p0').answer?.flip).toBeNull();
  });

  it('公開の前後で鍵が変わる。変わらないと、見えるようになった人に届かない', () => {
    const a = { playerId: 'p1', flip: drawn, scores: {}, tally: null };
    const before = viewFor(base({ topicPhase: 'stage', answer: a }), 'ABCD', 'p1').answer?.flipKey;
    const after = viewFor(base({ topicPhase: 'reveal', answer: a }), 'ABCD', 'p1').answer?.flipKey;
    expect(before).not.toBe(after);
  });

  it('公開後は全員に同じ鍵が付く', () => {
    const s = base({ topicPhase: 'reveal', answer: { playerId: 'p1', flip: drawn, scores: {}, tally: null } });
    expect(viewFor(s, 'ABCD', 'p0').answer?.flipKey).toBe(viewFor(s, 'ABCD', 'p1').answer?.flipKey);
  });

  it('回答が無ければ鍵も無い', () => {
    expect(viewFor(base({ answer: null }), 'ABCD', 'p0').answer).toBeNull();
  });
});
