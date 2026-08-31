import { FLIP_H, FLIP_W, type FontKey, type Flip, type Stroke, type TextItem } from '../engine/types';

/**
 * フリップの描画（見るだけ）。
 *
 * 線は SVG。論理座標のまま置けるので、書いた人と見る人で位置がずれない。
 * **文字は HTML の箱**（div）で、SVG の上に重ねる。SVG の `<text>` は折り返さないので、
 * パワポのような「箱の幅で自動的に折り返す」を作れないため。
 * 箱の位置と大きさは全部 % と論理px からの換算で置くので、画面の大きさが変わっても崩れない。
 */

export const STROKE_COLOR: Record<Stroke['color'], string> = {
  black: '#16181d',
  red: '#c8322f',
  blue: '#2b5bbd',
};
export const STROKE_W = { 1: 7, 2: 14, 3: 26 } as const;

/**
 * 書体。**端末に入っているものだけを並べる**（Web フォントは読み込まない）。
 * 前から順に試すので、無い環境でも必ず何かに落ちる。
 *
 * 落ちたときに「ゴシックに見える」ことだけは避ける。ポップが無い端末では
 * 教科書体へ、筆が無ければ明朝へ——**系統の近いものへ落とす**。
 */
export const FONT_STACK: Record<FontKey, string> = {
  gothic: "'Noto Sans JP','Yu Gothic','Hiragino Kaku Gothic ProN','Meiryo',sans-serif",
  mincho: "'Shippori Mincho','Yu Mincho','Hiragino Mincho ProN','MS PMincho',serif",
  round: "'Zen Maru Gothic','Hiragino Maru Gothic ProN','Meiryo',sans-serif",
  pop: "'Mochiy Pop One','HGP創英角ﾎﾟｯﾌﾟ体','Hiragino Maru Gothic ProN',sans-serif",
  brush: "'Yuji Syuku','HGP行書体','Yu Mincho','Hiragino Mincho ProN',serif",
  mono: "'Yusei Magic','Yu Gothic','Hiragino Kaku Gothic ProN',sans-serif",
};

export const FONT_LABEL: Record<FontKey, string> = {
  gothic: 'ゴシック',
  mincho: '明朝',
  round: '丸ゴ',
  pop: 'ポップ',
  brush: '筆',
  // 脱力系。手書きの気の抜けた感じで、声の小ささや投げやりさを出せる
  mono: '脱力',
};

/** 書体ごとの太さ。ポップや筆は元が太いので、足すと潰れる */
const FONT_WEIGHT: Record<FontKey, number> = {
  gothic: 900, mincho: 700, round: 900, pop: 400, brush: 400, mono: 400,
};

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

/** 論理px を板の幅に対する % に直す。板がどんな大きさで表示されても同じ絵になる */
const pw = (v: number) => `${(v / FLIP_W) * 100}%`;
const ph = (v: number) => `${(v / FLIP_H) * 100}%`;

/**
 * 文字の箱1つ分の見た目。編集中も表示だけのときも同じ数字で置くので、
 * 書いている画面と場に出る絵がずれない。
 */
export function boxStyle(t: TextItem): React.CSSProperties {
  return {
    position: 'absolute',
    left: pw(t.x - t.w / 2),
    top: ph(t.y),
    width: pw(t.w),
    transform: `translateY(-50%) rotate(${t.rot}deg)`,
    // 大きさは板の幅に対する割合で持つ。px で持つと拡大縮小で崩れる
    fontSize: `${(t.size / FLIP_W) * 100}cqw`,
    fontFamily: FONT_STACK[t.font],
    fontWeight: FONT_WEIGHT[t.font],
    lineHeight: 1.25,
    color: '#16181d',
    textAlign: t.align,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
  };
}

export function TextLayer({ texts }: { texts: TextItem[] }) {
  return (
    <>
      {texts.map((t, i) => (
        <div key={i} style={boxStyle(t)}>{t.text}</div>
      ))}
    </>
  );
}

/** 描画順は「手書き → 文字」。文字が常に上に出る（SPEC.md §4.2） */
export function FlipView({ flip, lift }: { flip: Flip; lift?: boolean }) {
  return (
    <div className={`board${lift ? ' lift' : ''}`}>
      <svg className="ink" viewBox={`0 0 ${FLIP_W} ${FLIP_H}`} role="img">
        <StrokeLayer strokes={flip.strokes} />
      </svg>
      <TextLayer texts={flip.texts} />
    </div>
  );
}
