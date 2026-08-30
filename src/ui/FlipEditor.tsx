import { useCallback, useRef, useState } from 'react';
import {
  FLIP_H, FLIP_W, emptyFlip,
  type Flip, type Stroke, type StrokeColor, type TextItem,
} from '../engine/types';
import { LIMIT } from '../net/events';
import { StrokeLayer, TextLayer, textBox } from './Flip';

/**
 * フリップを書く（SPEC.md §4.2）。手書きと文字は1枚に混在できる。
 *
 * 消しゴムは持たない。マウスで細かく消すのは実際やりにくいので、
 * ストローク単位の「1つ戻す」で足りる。
 */

type Props = {
  flip: Flip;
  onChange: (f: Flip) => void;
  disabled?: boolean;
  /** 書き始め／書き終わりを外へ伝える。中身は送らない（真偽値だけ配る） */
  onActivity?: (writing: boolean) => void;
};

const WIDTHS = [1, 2, 3] as const;
const SIZES = [1, 2, 3] as const;

export function FlipEditor({ flip, onChange, disabled, onActivity }: Props) {
  // 色は黒だけ。選択肢を出さない分、太さに場所を譲る
  const color: StrokeColor = 'black';
  const [width, setWidth] = useState<Stroke['width']>(2);
  const [size, setSize] = useState<TextItem['size']>(2);
  const [draft, setDraft] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const drawing = useRef<number[] | null>(null);
  const dragging = useRef<number | null>(null);

  /** 画面座標を論理座標に直す。CSS で縮んでいても書いた位置がずれない */
  const toLogical = useCallback((e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * FLIP_W;
    const y = ((e.clientY - r.top) / r.height) * FLIP_H;
    return [Math.min(FLIP_W, Math.max(0, x)), Math.min(FLIP_H, Math.max(0, y))];
  }, []);

  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    svg.current?.setPointerCapture(e.pointerId);
    if (dragging.current !== null) return; // 文字をつかんでいる
    setSel(null);
    const [x, y] = toLogical(e);
    drawing.current = [x, y];
    onActivity?.(true);
    onChange({ ...flip, strokes: [...flip.strokes, { color, width, points: [x, y] }] });
  };

  const move = (e: React.PointerEvent) => {
    if (disabled) return;
    const [x, y] = toLogical(e);

    if (dragging.current !== null) {
      const texts = flip.texts.map((t, i) => {
        if (i !== dragging.current) return t;
        // 板の外へ持ち出せないようにする。折り返したあとの大きさで測るので、
        // 長い文でも端が切れない
        const { w, h } = textBox(t);
        return {
          ...t,
          x: Math.min(FLIP_W - w / 2, Math.max(w / 2, x)),
          y: Math.min(FLIP_H - h / 2, Math.max(h / 2, y)),
        };
      });
      onChange({ ...flip, texts });
      return;
    }
    if (!drawing.current) return;
    const last = flip.strokes[flip.strokes.length - 1];
    if (!last) return;
    // 近すぎる点は捨てる。1本の線が数千点になると通信も描画も重い
    const n = last.points.length;
    const dx = x - last.points[n - 2];
    const dy = y - last.points[n - 1];
    if (dx * dx + dy * dy < 36) return;
    const strokes = [...flip.strokes];
    strokes[strokes.length - 1] = { ...last, points: [...last.points, x, y] };
    onChange({ ...flip, strokes });
  };

  const up = () => {
    drawing.current = null;
    dragging.current = null;
    onActivity?.(false);
  };

  const grabText = (i: number, e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    dragging.current = i;
    setSel(i);
  };

  const putText = () => {
    const text = draft.trim();
    if (!text || flip.texts.length >= LIMIT.texts) return;
    onChange({
      ...flip,
      texts: [...flip.texts, { text: text.slice(0, LIMIT.textLen), x: FLIP_W / 2, y: FLIP_H / 2, size }],
    });
    setDraft('');
    setSel(flip.texts.length);
  };

  const dirty = flip.strokes.length > 0 || flip.texts.length > 0;

  const undo = () => {
    // 直前に足したものを1つ戻す。文字を足した直後なら文字、線なら線
    if (flip.texts.length && sel !== null) {
      onChange({ ...flip, texts: flip.texts.filter((_, i) => i !== sel) });
      setSel(null);
      return;
    }
    if (flip.strokes.length) onChange({ ...flip, strokes: flip.strokes.slice(0, -1) });
    else if (flip.texts.length) onChange({ ...flip, texts: flip.texts.slice(0, -1) });
  };

  return (
    <div>
      <div className="tools">
        {WIDTHS.map((w) => (
          <button key={w} className="w" data-on={width === w ? 1 : 0} onClick={() => setWidth(w)} disabled={disabled}>
            {w === 1 ? '細' : w === 2 ? '中' : '太'}
          </button>
        ))}
        <span className="sep" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, LIMIT.textLen))}
          onKeyDown={(e) => e.key === 'Enter' && putText()}
          placeholder="文字を打つ"
          disabled={disabled}
          className="draft"
        />
        {SIZES.map((s) => (
          <button key={s} className="w" data-on={size === s ? 1 : 0} onClick={() => setSize(s)} disabled={disabled}>
            {s === 1 ? '小' : s === 2 ? '中' : '大'}
          </button>
        ))}
        {/* 取り消し系は「乗せる」の左。実行系と並べると押し間違える */}
        <button className="icon" onClick={undo} disabled={disabled || !dirty} title="1つ戻す" aria-label="1つ戻す">
          ↩
        </button>
        <button
          className="icon"
          onClick={() => { onChange(emptyFlip()); setSel(null); }}
          disabled={disabled || !dirty}
          title="全部消す"
          aria-label="全部消す"
        >
          全消
        </button>
        <button onClick={putText} disabled={disabled || !draft.trim()}>フリップに乗せる</button>
      </div>

      <svg
        ref={svg}
        className="board"
        viewBox={`0 0 ${FLIP_W} ${FLIP_H}`}
        style={{ cursor: disabled ? 'default' : 'crosshair', opacity: disabled ? .7 : 1 }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <StrokeLayer strokes={flip.strokes} />
        <TextLayer texts={flip.texts} onDown={grabText} />
        {sel !== null && flip.texts[sel] && (
          <circle cx={flip.texts[sel].x} cy={flip.texts[sel].y} r={10} fill="#c9a227" />
        )}
      </svg>
      <p className="hint">マウスでそのまま描けます。乗せた文字はドラッグで動かせます。</p>
    </div>
  );
}
