import { describe, expect, it } from 'vitest';
import { tally } from './judge';
import type { Score } from './types';

/**
 * 判定の境界（SPEC.md §6.4）。
 *
 * ここは浮動小数点で比べないことが要点なので、平均がちょうど境界に乗る
 * 票の並びを狙って置く。実装が `合計/n` を先に計算する形に戻ったら落ちる。
 */
describe('tally', () => {
  const t = (...s: Score[]) => tally(s).verdict;

  it('採点者が0人なら判定なし', () => {
    expect(tally([]).verdict).toBe('none');
    expect(tally([]).judges).toBe(0);
  });

  it('全員が大笑いなら満点大笑い', () => {
    expect(t(3)).toBe('perfect');
    expect(t(3, 3)).toBe('perfect');
    expect(t(3, 3, 3, 3, 3)).toBe('perfect');
  });

  it('1人でも大笑いでなければ満点にならない', () => {
    expect(t(3, 3, 2)).not.toBe('perfect');
  });

  it('平均 7/3 ちょうどは大笑い（境界を含む）', () => {
    // 3+3+1 = 7、n=3 → 平均 2.333…。7*3 >= 7*3 なので大笑い
    expect(t(3, 3, 1)).toBe('big');
    expect(t(3, 2, 2)).toBe('big'); // 合計7 同じ
  });

  it('平均が 7/3 をわずかに下回れば中笑い', () => {
    // 合計 6、n=3 → 平均 2.0
    expect(t(3, 2, 1)).toBe('medium');
  });

  it('平均 5/3 ちょうどは中笑い（境界を含む）', () => {
    // 合計5、n=3 → 平均 1.666…。5*3 >= 5*3 なので中笑い
    expect(t(2, 2, 1)).toBe('medium');
    expect(t(3, 1, 1)).toBe('medium');
  });

  it('平均が 5/3 をわずかに下回れば小笑い', () => {
    // 合計4、n=3 → 平均 1.333…
    expect(t(2, 1, 1)).toBe('small');
    expect(t(1, 1, 1)).toBe('small');
  });

  it('採点者1人でも同じ物差しで判定する', () => {
    expect(t(1)).toBe('small');
    expect(t(2)).toBe('medium');
    expect(t(3)).toBe('perfect'); // 1人が大笑い＝全員が大笑い
  });

  it('内訳は誰が押したかを持たず、数だけ返す', () => {
    const r = tally([1, 3, 3, 2]);
    expect(r.counts).toEqual({ 1: 1, 2: 1, 3: 2 });
    expect(r.judges).toBe(4);
  });

  it('票の並び順で結果が変わらない', () => {
    expect(t(1, 3, 3)).toBe(t(3, 3, 1));
    expect(t(2, 1, 2)).toBe(t(1, 2, 2));
  });
});
