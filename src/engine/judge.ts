import type { Score, Tally, Verdict } from './types';

/**
 * 採点の集計（SPEC.md §6.4）。
 *
 * 境界は浮動小数点で比べない。平均を出して 2.3333... と比べると、
 * 同じ票の並びでも足す順で判定が変わりうる。合計と人数の整数のまま比べる。
 */
export function tally(scores: readonly Score[]): Tally {
  const n = scores.length;
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const s of scores) counts[s] += 1;

  if (n === 0) return { verdict: 'none', counts, judges: 0 };

  const sum = scores.reduce<number>((a, b) => a + b, 0);
  let verdict: Verdict;
  if (sum === 3 * n) verdict = 'perfect';        // 全員が大笑い
  else if (sum * 3 >= 7 * n) verdict = 'big';    // 平均 ≧ 2.334
  else if (sum * 3 >= 5 * n) verdict = 'medium'; // 平均 ≧ 1.667
  else verdict = 'small';

  return { verdict, counts, judges: n };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  small: '小笑い',
  medium: '中笑い',
  big: '大笑い',
  perfect: '満点大笑い',
  none: '判定なし',
};
