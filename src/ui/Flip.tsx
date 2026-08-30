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

export function TextLayer({ texts, onDown }: { texts: TextItem[]; onDown?: (i: number, e: React.PointerEvent) => void }) {
  return (
    <>
      {texts.map((t, i) => (
        <text
          key={i}
          x={t.x}
          y={t.y}
          fontSize={TEXT_SIZE[t.size]}
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
          {t.text}
        </text>
      ))}
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
