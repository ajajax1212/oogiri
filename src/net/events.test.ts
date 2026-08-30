import { describe, expect, it } from 'vitest';
import { checkFlip, checkTopicText, checkWord, cleanName, EV, LIMIT } from './events';
import { FLIP_H, FLIP_W, type Flip } from '../engine/types';

/**
 * サーバー側の検証（SPEC.md §4.4 / §9.2 / TOPIC-GEN.md §9.1）。
 *
 * クライアントのボタン制御はあくまで見た目なので、
 * ここが通してしまうものは通信を直接叩けば素通りする。
 */

const stroke = (points: number[]) => ({ color: 'black' as const, width: 2 as const, points });

describe('EV', () => {
  it('イベント名が重複していない（片方だけ書き換えると黙って効かなくなる）', () => {
    const names = Object.values(EV);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('cleanName', () => {
  it('空白だけの名前は通さない', () => {
    expect(cleanName('　 ')).toBeNull();
    expect(cleanName('')).toBeNull();
    expect(cleanName(123)).toBeNull();
  });
  it('長すぎる名前は切る', () => {
    expect(cleanName('あ'.repeat(30))).toHaveLength(LIMIT.name);
  });
});

describe('checkFlip', () => {
  const ok = (f: Partial<Flip>) => checkFlip({ strokes: [], texts: [], ...f });

  it('空のフリップも形としては通す（空かどうかの判断は reducer 側）', () => {
    expect(ok({})).not.toBeNull();
  });

  it('盤面の外に出た座標は拒否する（丸めない）', () => {
    // 丸めて通すと、書いた本人の画面と場に出る絵が食い違う
    expect(ok({ strokes: [stroke([0, 0, FLIP_W + 1, 0])] })).toBeNull();
    expect(ok({ strokes: [stroke([0, -1])] })).toBeNull();
  });

  it('数値でない座標を拒否する', () => {
    expect(ok({ strokes: [stroke([0, 0, NaN, 5])] })).toBeNull();
    expect(ok({ strokes: [stroke([0, 0, Infinity, 5])] })).toBeNull();
  });

  it('点が奇数個の線を拒否する', () => {
    expect(ok({ strokes: [stroke([0, 0, 10])] })).toBeNull();
  });

  it('知らない色や太さを拒否する', () => {
    expect(checkFlip({ strokes: [{ color: 'gold', width: 2, points: [0, 0] }], texts: [] })).toBeNull();
    expect(checkFlip({ strokes: [{ color: 'black', width: 9, points: [0, 0] }], texts: [] })).toBeNull();
  });

  it('線の本数の上限を超えたら拒否する', () => {
    const many = Array.from({ length: LIMIT.strokes + 1 }, () => stroke([0, 0, 1, 1]));
    expect(ok({ strokes: many })).toBeNull();
  });

  it('点の総数の上限を超えたら拒否する', () => {
    // 1本あたり 1000点 × 41本 = 41000点 > 40000
    const long = Array.from({ length: 41 }, () =>
      stroke(Array.from({ length: 2000 }, (_, i) => (i % 2 ? 1 : 1))),
    );
    expect(ok({ strokes: long })).toBeNull();
  });

  it('文字要素の数と長さの上限を守る', () => {
    const t = (text: string) => ({ text, x: 10, y: 10, size: 2 as const });
    expect(ok({ texts: Array.from({ length: LIMIT.texts + 1 }, () => t('あ')) })).toBeNull();
    expect(ok({ texts: [t('あ'.repeat(LIMIT.textLen + 1))] })).toBeNull();
    expect(ok({ texts: [t('  ')] })).toBeNull();
    expect(ok({ texts: [{ text: 'あ', x: FLIP_W + 1, y: 0, size: 2 }] })).toBeNull();
    expect(ok({ texts: [t('あ'.repeat(LIMIT.textLen))] })).not.toBeNull();
  });

  it('形が違うものを拒否する', () => {
    expect(checkFlip(null)).toBeNull();
    expect(checkFlip({ strokes: 'x', texts: [] })).toBeNull();
    expect(checkFlip({ strokes: [], texts: {} })).toBeNull();
  });

  it('盤面ちょうどの座標は通す', () => {
    expect(ok({ strokes: [stroke([0, 0, FLIP_W, FLIP_H])] })).not.toBeNull();
  });
});

describe('checkWord（持ち寄り語）', () => {
  it('「なに」は無い。物の持ち寄りは事故が多かったので落とした', () => {
    expect(checkWord('会長のカツラ', 'thing')).toBeNull();
    expect(checkWord('たけし', 'person')).not.toBeNull();
    expect(checkWord('駅前のドトール', 'place')).not.toBeNull();
    expect(checkWord('合宿', 'act')).not.toBeNull();
  });
  it('長さと空白を見る', () => {
    expect(checkWord('  ', 'person')).toBeNull();
    expect(checkWord('あ'.repeat(LIMIT.wordLen + 1), 'person')).toBeNull();
    expect(checkWord(' たけし ', 'person')?.word).toBe('たけし');
  });
  it('知らない種類を拒否する', () => {
    expect(checkWord('たけし', 'hero')).toBeNull();
    expect(checkWord('たけし', undefined)).toBeNull();
  });
});

describe('checkTopicText（投稿されたお題）', () => {
  it('短すぎる／長すぎるものを拒否する', () => {
    expect(checkTopicText('あ'.repeat(LIMIT.topicMin - 1))).toBeNull();
    expect(checkTopicText('あ'.repeat(LIMIT.topicMax + 1))).toBeNull();
    expect(checkTopicText('あ'.repeat(LIMIT.topicMin))).not.toBeNull();
  });
  it('前後の空白を落とし、連続する空白を1つにする', () => {
    expect(checkTopicText('  こんな　　朝は嫌だ  ')).toBe('こんな 朝は嫌だ');
  });
  it('文字列でないものを拒否する', () => {
    expect(checkTopicText(null)).toBeNull();
    expect(checkTopicText(42)).toBeNull();
  });
});
