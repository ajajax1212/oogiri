import { FLIP_H, FLIP_W, type Flip, type Stroke, type TextItem } from '../engine/types';

/**
 * フリップの描画（見るだけ）。
 *
 * canvas ではなく SVG で描く。論理座標のまま置けるので、書いた人と見る人で
 * 位置がずれない。どの画面サイズでも線が滑らかなままなのも SVG の理由。
 */

export const STROKE_COLOR: Record<Stroke['color'], string> = {
  black: '#16181d',
  red: '#c8322f',
  blue: '#2b5bbd',
};
export const STROKE_W = { 1: 7, 2: 14, 3: 26 } as const;
export const TEXT_SIZE = { 1: 58, 2: 92, 3: 140 } as const;

const path = (points: number[]): string => {
  let d = `M ${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length; i += 2) d += ` L ${points[i]} ${points[i + 1]}`;
  return d;
};

export function StrokeLayer({ strokes }: { strokes: Stroke[] }) {
  return (
    <>
      {strokes.map((s, i) => (
        <path
          key={i}
          d={path(s.points)}
          fill="none"
          stroke={STROKE_COLOR[s.color]}
          strokeWidth={STROKE_W[s.width]}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </>
  );
}

/** 左右に残す余白。板の縁ぎりぎりまで文字を置くと窮屈に見える */
const PAD = 70;
/** 行の高さ。文字の大きさに対する倍率 */
const LINE_H = 1.25;

/**
 * 板に収まる幅で行に割る。
 *
 * SVG の `<text>` は折り返さないので、放っておくと長い回答が板からはみ出す。
 * **書いた文字列そのものは変えない**（保存されるのは1本の文字列のまま）。
 * ここでやるのは表示のための折り返しだけ。
 *
 * 幅は「全角1文字 ≒ 1em、半角 ≒ 0.55em」で見積もる。実測しないのは、
 * 書いた人と見る人でフォントが違っても同じ位置で折るため。canvas で測ると
 * 端末ごとに行が変わって、書いた本人の画面と場に出る絵が食い違う。
 */
function wrap(text: string, size: TextItem['size']): string[] {
  const em = TEXT_SIZE[size];
  const max = FLIP_W - PAD * 2;
  const half = /[\x20-\x7e｡-ﾟ]/; // 半角英数記号とカナ

  const lines: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; w = 0; continue; }
    const cw = (half.test(ch) ? 0.55 : 1) * em;
    if (w + cw > max && line) { lines.push(line); line = ''; w = 0; }
    line += ch;
    w += cw;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** 折り返したあとの、文字のかたまりの大きさ。掴んで動かす範囲を決めるのに使う */
export function textBox(t: TextItem): { w: number; h: number } {
  const em = TEXT_SIZE[t.size];
  const lines = wrap(t.text, t.size);
  const half = /[\x20-\x7e｡-ﾟ]/;
  const width = (s: string) =>
    [...s].reduce((a, ch) => a + (half.test(ch) ? 0.55 : 1) * em, 0);
  return {
    w: Math.max(...lines.map(width), 0),
    h: em * (1 + LINE_H * (lines.length - 1)),
  };
}

export function TextLayer({ texts, onDown }: { texts: TextItem[]; onDown?: (i: number, e: React.PointerEvent) => void }) {
  return (
    <>
      {texts.map((t, i) => {
        const lines = wrap(t.text, t.size);
        const em = TEXT_SIZE[t.size];
        const step = em * LINE_H;
        // 掴んだ位置を「かたまりの中心」に保つ。1行目を基準にすると、
        // 行が増えるたびに文字が下へずれていく
        const top = t.y - (step * (lines.length - 1)) / 2;
        return (
          <text
            key={i}
            x={t.x}
            y={top}
            fontSize={em}
            fill="#16181d"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              fontFamily: "'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif",
              fontWeight: 800,
              cursor: onDown ? 'move' : 'default',
              userSelect: 'none',
            }}
            onPointerDown={onDown ? (e) => onDown(i, e) : undefined}
          >
            {lines.map((l, k) => (
              <tspan key={k} x={t.x} dy={k === 0 ? 0 : step}>{l}</tspan>
            ))}
          </text>
        );
      })}
    </>
  );
}

/** 描画順は「手書き → 文字」。文字が常に上に出る（SPEC.md §4.2） */
export function FlipView({ flip, lift }: { flip: Flip; lift?: boolean }) {
  return (
    <svg className={`board${lift ? ' lift' : ''}`} viewBox={`0 0 ${FLIP_W} ${FLIP_H}`} role="img">
      <StrokeLayer strokes={flip.strokes} />
      <TextLayer texts={flip.texts} />
    </svg>
  );
}
