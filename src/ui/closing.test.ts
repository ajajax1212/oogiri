import { describe, expect, it } from 'vitest';
import { BUDGET, READ_MIN, RUNGS, STOP_AT, closingPlan, isRush, seedOf, stepAt } from './closing';
import type { Verdict } from '../engine/types';

/**
 * 決着の段取り（SPEC.md §10.2）。
 *
 * ここは**画面を見ても間違いに気づけない**種類のものが多い。
 * 溜めが長すぎて判定が読めない、人によって止まる瞬間がずれる、
 * 動きを嫌う設定で何も出てこない ―― どれも「たまたま今回は大丈夫だった」で通ってしまう。
 */

const VERDICTS: Verdict[] = ['none', 'small', 'medium', 'big', 'perfect'];
const plan = (verdict: Verdict, seed = 'a|b|c', rush = false, reduced = false) =>
  closingPlan({ verdict, seed, rush, reduced });

describe('止まる段が判定そのもの', () => {
  it('小3 / 中6 / 大9 / 満点12', () => {
    expect(STOP_AT.small).toBe(3);
    expect(STOP_AT.medium).toBe(6);
    expect(STOP_AT.big).toBe(9);
    expect(STOP_AT.perfect).toBe(RUNGS);
    expect(STOP_AT.none).toBe(0);
  });

  it('段の時刻は段数ぶんあって、必ず増えていく', () => {
    for (const v of VERDICTS) {
      const p = plan(v);
      expect(p.at).toHaveLength(STOP_AT[v]);
      for (let i = 1; i < p.at.length; i += 1) expect(p.at[i]).toBeGreaterThan(p.at[i - 1]);
    }
  });

  it('最後の段が止まってから判定が出る（先に出ると溜めが無意味になる）', () => {
    for (const v of VERDICTS) {
      const p = plan(v);
      const last = p.at[p.at.length - 1] ?? 0;
      expect(p.verdictAt).toBeGreaterThanOrEqual(last);
    }
  });
});

describe('尺', () => {
  it('判定を読む時間が必ず残る', () => {
    // 5.7秒を全部溜めに使うと、判定が出た瞬間に画面が次へ行って読めない
    for (const v of VERDICTS) {
      for (let i = 0; i < 50; i += 1) {
        const p = plan(v, `seed-${i}`);
        expect(p.verdictAt).toBeLessThanOrEqual(BUDGET - READ_MIN);
        expect(p.readMs).toBeGreaterThanOrEqual(READ_MIN);
      }
    }
  });

  it('判定の声（3.7秒）が鳴り終わってから次の場面へ行く', () => {
    // sound.ts の FILES に実測が書いてある。いちばん長いのが 満点大笑い.wav の 3.70秒。
    // ここが割れると、笑い声の途中で白紙のフリップに切り替わる
    const LAUGH = 3700;
    for (const v of ['small', 'medium', 'big', 'perfect'] as Verdict[]) {
      for (let i = 0; i < 50; i += 1) {
        const p = plan(v, `seed-${i}`);
        expect(p.verdictAt + LAUGH).toBeLessThanOrEqual(BUDGET);
      }
    }
  });

  it('小笑いは最低2秒使う（サクサク出すと気の毒）', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(plan('small', `seed-${i}`).verdictAt).toBeGreaterThanOrEqual(2000);
    }
  });

  it('採点が速かった満点は、普通の満点より短い', () => {
    for (let i = 0; i < 20; i += 1) {
      const seed = `seed-${i}`;
      expect(plan('perfect', seed, true).verdictAt).toBeLessThan(plan('perfect', seed).verdictAt);
    }
  });
});

describe('全員の画面で同じ瞬間に止まる', () => {
  it('同じ種なら何度作っても同じ段取りになる', () => {
    // 各画面が Math.random() を呼ぶと、同じ部屋なのに人によって判定の出る瞬間がずれる
    for (const v of VERDICTS) {
      const a = plan(v, 'p1|t7|big');
      const b = plan(v, 'p1|t7|big');
      expect(b).toEqual(a);
    }
  });

  it('種が違えば段取りも違う（毎回同じリズムだと2問目から読める）', () => {
    const a = plan('big', seedOf('p1', 't1', 'big'));
    const b = plan('big', seedOf('p1', 't2', 'big'));
    expect(b.at).not.toEqual(a.at);
  });

  it('種は回答者とお題と判定から決まる', () => {
    expect(seedOf('p1', 't1', 'big')).toBe(seedOf('p1', 't1', 'big'));
    expect(seedOf('p1', 't1', 'big')).not.toBe(seedOf('p2', 't1', 'big'));
  });
});

describe('動きを嫌う設定（prefers-reduced-motion）', () => {
  it('遅延ごと畳む。判定は即座に出す', () => {
    // 長さだけ潰して遅延を残すと、何も動かないまま数秒間ただの空白になる。
    // 伝えるべきは「何笑いか」なので、そこだけは必ず出す
    for (const v of VERDICTS) {
      const p = plan(v, 'x', false, true);
      expect(p.verdictAt).toBe(0);
      expect(p.at.every((t) => t === 0)).toBe(true);
      expect(p.stop).toBe(STOP_AT[v]); // 止まる段＝判定は動かない
    }
  });
});

describe('「採点が速い」の判定', () => {
  it('測れなかったら必ず普通に落とす', () => {
    // 途中から入った人は reveal を見ていない。ここで誤判定すると
    // その人の画面だけ矢継ぎ早になる
    expect(isRush(null, 2)).toBe(false);
    expect(isRush(NaN, 2)).toBe(false);
    expect(isRush(0, 2)).toBe(false);
    expect(isRush(-5, 2)).toBe(false);
    expect(isRush(500, 0)).toBe(false);
  });

  it('人数で割る（3人が押すのに1人ぶんの時間しか見ないと、まず速くならない）', () => {
    expect(isRush(3000, 1)).toBe(false);
    expect(isRush(3000, 3)).toBe(true);
  });
});

describe('途中から入った人', () => {
  it('経過ぶんの段は上がった状態から始める', () => {
    const p = plan('big');
    expect(stepAt(p, 0)).toBe(0);
    expect(stepAt(p, p.at[2])).toBe(3);
    expect(stepAt(p, 999_999)).toBe(p.at.length);
  });
});
