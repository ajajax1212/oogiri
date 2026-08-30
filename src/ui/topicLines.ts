/**
 * お題を「見せるための行」に割る（画面だけの都合。お題の文そのものは変えない）。
 *
 * 参考にした見た目では、お題が画面幅いっぱいの極太で2行に置かれている。
 * サーバーから来るお題は改行を持たない1本の文字列なので、割り位置はこちらで決める。
 *
 * CSS の折り返し（word-break / text-wrap: balance）に任せなかった理由:
 *  - 日本語は任意の位置で折れるので、句読点の直前や「」の途中で切れる
 *  - 行数が確定しないと文字サイズを決められない。ここは「画面幅 ÷ 最長行の字数」で
 *    大きさを出したいので、行が何本になるかを先に知る必要がある
 *
 * 貪欲法ではなく全探索（DP）にしたのは、行の長さを揃えることを優先したいから。
 * 貪欲だと最後の行だけが極端に短くなり、参考画像のような座りにならない。
 */

/** 全角は1、半角は0.5として数える。混在しても行の長さが釣り合う */
const widthOf = (ch: string): number => (/[\x00-\x7F｡-ﾟ]/.test(ch) ? 0.5 : 1);

/** この文字の後ろなら気持ちよく切れる */
const GOOD_BREAK = new Set(['。', '、', '，', ',', '！', '!', '？', '?', '」', '』', '）', ')', '…', '・']);
/** 行頭に来ると不格好な文字（禁則） */
const NO_HEAD = new Set([
  '。', '、', '，', ',', '！', '!', '？', '?', '」', '』', '）', ')', '…', '・',
  'ー', 'ッ', 'ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ャ', 'ュ', 'ョ', 'ッ', '々',
]);
/** 行末に来ると不格好な文字（禁則） */
const NO_TAIL = new Set(['「', '『', '（', '(']);

const HIRAGANA = /[ぁ-ゖ]/;
/** 助詞。この直後は文節の切れ目である見込みが高い */
const PARTICLE = new Set(['が', 'を', 'に', 'は', 'へ', 'と', 'も', 'の', 'で', 'や', 'ら']);
/** 用言の言い切り。ここも切れ目になりやすいが、助詞ほど当てにならない */
const ENDING = new Set(['た', 'る', 'て', 'ん']);

/**
 * 切り位置の罰点。行の長さの偏り（二乗）と足して、合計が最小の割り方を選ぶ。
 *
 * 形態素解析は入れない（辞書を持ち込むと依存が増える）。代わりに
 * 「ひらがなの次に漢字・カタカナが来るところが文節の頭」という当て推量で済ませる。
 * 「立ち話」のような語は誤爆するので、助詞の後ろを別格に安くして寄せてある。
 * 次がひらがなの位置は語の途中である見込みが高いので、いちばん高く付ける。
 */
const COST = {
  GOOD: 0,       // 句読点や閉じ括弧の後ろ
  PARTICLE: 2,   // 助詞 → 漢字・カタカナ
  ENDING: 10,    // 用言の語尾 → 漢字・カタカナ
  CHUNK: 30,     // その他のひらがな → 漢字・カタカナ
  SOLID: 90,     // 漢字・カタカナ同士のあいだ。熟語を割りやすいので高く付ける
  MIDWORD: 70,   // 次がひらがな。語の途中の見込み
} as const;

export function splitTopic(text: string, maxLines = 3, perLine = 13): string[] {
  const s = text.trim();
  const ch = Array.from(s);
  const n = ch.length;
  if (!n) return [];

  const w: number[] = ch.map(widthOf);
  const total = w.reduce((a, b) => a + b, 0);
  const lines = Math.min(maxLines, Math.max(1, Math.ceil(total / perLine)));
  if (lines === 1) return [s];

  const target = total / lines;

  // 累積幅。行の幅を O(1) で出す
  const acc: number[] = [0];
  for (let i = 0; i < n; i++) acc.push(acc[i] + w[i]);

  /** i 文字目の前で改行したときの罰点（i は 1..n-1） */
  const breakCost = (i: number): number => {
    const prev = ch[i - 1];
    const next = ch[i];
    if (NO_HEAD.has(next) || NO_TAIL.has(prev)) return Infinity;
    if (GOOD_BREAK.has(prev)) return COST.GOOD;
    if (HIRAGANA.test(next)) return COST.MIDWORD;
    if (!HIRAGANA.test(prev)) return COST.SOLID;
    if (PARTICLE.has(prev)) return COST.PARTICLE;
    if (ENDING.has(prev)) return COST.ENDING;
    return COST.CHUNK;
  };

  // best[k][i] = 先頭 i 文字を k 行に組んだときの最小コスト
  const best: number[][] = Array.from({ length: lines + 1 }, () => Array<number>(n + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: lines + 1 }, () => Array<number>(n + 1).fill(-1));
  best[0][0] = 0;

  for (let k = 1; k <= lines; k++) {
    for (let i = 1; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        const prev = best[k - 1][j];
        if (prev === Infinity) continue;
        const cut = j === 0 ? 0 : breakCost(j);
        if (cut === Infinity) continue;
        const len = acc[i] - acc[j];
        const cost = prev + cut + (len - target) ** 2;
        if (cost < best[k][i]) {
          best[k][i] = cost;
          from[k][i] = j;
        }
      }
    }
  }

  // 禁則で 1 通りも組めないことがある（短い文＋記号だらけ）。そのときは割らずに返す
  if (best[lines][n] === Infinity) return [s];

  const out: string[] = [];
  let i = n;
  for (let k = lines; k >= 1; k--) {
    const j = from[k][i];
    out.unshift(ch.slice(j, i).join(''));
    i = j;
  }
  return out;
}

/** 行の中でいちばん長いものの字数。文字の大きさを「画面幅 ÷ これ」で決めるのに使う */
export const widestOf = (lines: string[]): number =>
  lines.reduce((m, l) => Math.max(m, Array.from(l).reduce((a, c) => a + widthOf(c), 0)), 1);
