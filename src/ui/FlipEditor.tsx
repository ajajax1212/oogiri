import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FLIP_H, FLIP_W, FONTS, TEXT_MAX, TEXT_MIN, emptyFlip,
  type Flip, type FontKey, type Stroke, type StrokeColor, type TextItem,
} from '../engine/types';
import { LIMIT } from '../net/events';
import { FONT_LABEL, StrokeLayer, boxStyle } from './Flip';

/**
 * フリップを書く（SPEC.md §4.2）。手書きと文字は1枚に混在できる。
 *
 * 文字は**パワポのようなテキストボックス**にしてある。フリップをクリックすれば箱ができ、
 * その場で打てて、掴んで動かし、左右の印で幅を変え、大きさと書体を選べる。
 * 「小・中・大」の3段だったころは、囁きと絶叫を書き分けられなかった。
 * **声色を文字で出せることが、フリップ大喜利の表現の幅そのもの**なので、
 * 大きさは連続値、書体は系統の違うものを並べてある。
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
type Tool = 'pen' | 'text';

const newBox = (x: number, y: number, font: FontKey, size: number): TextItem => ({
  text: '', x, y, w: 900, size, font, rot: 0, align: 'center',
});

export function FlipEditor({ flip, onChange, disabled, onActivity }: Props) {
  const [tool, setTool] = useState<Tool>('text');
  const color: StrokeColor = 'black'; // 色は黒だけ。選択肢を出さない分、他に場所を譲る
  const [width, setWidth] = useState<Stroke['width']>(2);
  const [font, setFont] = useState<FontKey>('gothic');
  const [size, setSize] = useState(120);
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const wrap = useRef<HTMLDivElement | null>(null);
  const drawing = useRef(false);
  const drag = useRef<{ i: number; dx: number; dy: number } | null>(null);
  const resize = useRef<{ i: number; side: -1 | 1; corner: boolean } | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const texts = flip.texts;
  const cur = sel !== null ? texts[sel] : null;

  /** 画面座標を論理座標に直す。CSS で縮んでいても書いた位置がずれない */
  const toLogical = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * FLIP_W;
    const y = ((e.clientY - r.top) / r.height) * FLIP_H;
    return [Math.min(FLIP_W, Math.max(0, x)), Math.min(FLIP_H, Math.max(0, y))];
  }, []);

  useEffect(() => {
    if (editing === null) return;
    const a = area.current;
    if (!a) return;
    a.focus();
    // 書き直しのとき、キャレットは末尾に置く。先頭のままだと
    // 打ち足したつもりの文字が頭に入る
    a.setSelectionRange(a.value.length, a.value.length);
  }, [editing]);

  const patch = (i: number, p: Partial<TextItem>) =>
    onChange({ ...flip, texts: texts.map((t, k) => (k === i ? { ...t, ...p } : t)) });

  // --- 板の上での操作 ---

  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    wrap.current?.setPointerCapture(e.pointerId);
    const [x, y] = toLogical(e);

    if (tool === 'pen') {
      setSel(null);
      setEditing(null);
      drawing.current = true;
      onActivity?.(true);
      onChange({ ...flip, strokes: [...flip.strokes, { color, width, points: [x, y] }] });
      return;
    }

    // 文字の道具。**箱は押した場所ではなく、必ず板の中央に出す**（本人の指定）。
    // 押した場所に出すと、端を押したときに箱が板からはみ出したまま生まれ、
    // 打ち始める前に動かす手間が要る。中央なら必ず全部見えている
    if (texts.length >= LIMIT.texts) { setSel(null); setEditing(null); return; }
    const i = texts.length;
    onChange({ ...flip, texts: [...texts, newBox(FLIP_W / 2, FLIP_H / 2, font, size)] });
    setSel(i);
    setEditing(i);
    onActivity?.(true);
  };

  /**
   * 押しても焦点を動かさせない。既定のままだと、押した瞬間にブラウザが焦点を
   * 板（＝body）へ移すので、こちらが textarea に当てた焦点が直後に外れ、
   * onBlur の dropEmpty が出来たての箱を捨ててしまう（箱が一瞬で消えた原因）。
   *
   * **pointerdown ではなく mousedown で止める。** pointerdown を止めると
   * Chrome は click も dblclick も発行しなくなり、書き直しのダブルクリックが
   * 死ぬ。焦点移動と文字選択は mousedown の既定動作なので、こちらで足りる。
   * textarea の中だけは通す。止めるとキャレットを置けなくなる
   */
  const keepFocus = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    e.preventDefault();
  };

  /**
   * 書き直しのダブルクリック。受け口は**板**に置く。箱側に付けても、
   * pointerdown で板がポインタを捕まえた時点で dblclick の宛先が板へ移るので、
   * 箱の onDoubleClick は一度も呼ばれない（実際ずっと効いていなかった）。
   * どの箱かは、直前の pointerdown が選んだ sel で分かる
   */
  const reopen = () => { if (sel !== null && !disabled) setEditing(sel); };

  const move = (e: React.PointerEvent) => {
    if (disabled) return;
    const [x, y] = toLogical(e);

    if (resize.current) {
      const { i, side, corner } = resize.current;
      const t = texts[i];
      // 掴んだ側の縁だけを動かす。反対の縁は動かない（パワポと同じ手触り）
      const edge = t.x + (side * t.w) / 2;
      const w = Math.max(120, Math.min(FLIP_W, t.w + side * (x - edge)));
      const x2 = t.x + (side * (w - t.w)) / 2;
      if (!corner) { patch(i, { w, x: x2 }); return; }
      // **角は箱と文字を一緒に拡縮する。**横の印が「折り返す幅だけ」を変えるのに対し、
      // 角は見た目の大きさそのものを変える道具。ここで文字を据え置くと、
      // 箱だけ広がって字が小さいまま残り、別物になる
      const k = w / t.w;
      patch(i, { w, x: x2, size: Math.min(TEXT_MAX, Math.max(TEXT_MIN, t.size * k)) });
      return;
    }
    if (drag.current) {
      const { i, dx, dy } = drag.current;
      patch(i, {
        x: Math.min(FLIP_W, Math.max(0, x - dx)),
        y: Math.min(FLIP_H, Math.max(0, y - dy)),
      });
      return;
    }
    if (!drawing.current) return;
    const last = flip.strokes[flip.strokes.length - 1];
    if (!last) return;
    // 近すぎる点は捨てる。1本の線が数千点になると通信も描画も重い
    const n = last.points.length;
    const ddx = x - last.points[n - 2];
    const ddy = y - last.points[n - 1];
    if (ddx * ddx + ddy * ddy < 36) return;
    const strokes = [...flip.strokes];
    strokes[strokes.length - 1] = { ...last, points: [...last.points, x, y] };
    onChange({ ...flip, strokes });
  };

  const up = () => {
    drawing.current = false;
    drag.current = null;
    resize.current = null;
    if (editing === null) onActivity?.(false);
  };

  const grabBox = (i: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    wrap.current?.setPointerCapture(e.pointerId);
    const [x, y] = toLogical(e);
    setSel(i);
    drag.current = { i, dx: x - texts[i].x, dy: y - texts[i].y };
  };

  const grabEdge = (i: number, side: -1 | 1, corner = false) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    wrap.current?.setPointerCapture(e.pointerId);
    setSel(i);
    resize.current = { i, side, corner };
  };

  // --- 道具箱 ---

  const dirty = flip.strokes.length > 0 || texts.length > 0;

  /** 中身が空のまま離れた箱は捨てる。押し間違いで空箱が残ると邪魔なだけ */
  const dropEmpty = () => {
    const keep = texts.filter((t) => t.text.trim());
    if (keep.length !== texts.length) {
      onChange({ ...flip, texts: keep });
      setSel(null);
    }
    setEditing(null);
    onActivity?.(false);
  };

  const undo = () => {
    if (sel !== null && texts[sel]) {
      onChange({ ...flip, texts: texts.filter((_, i) => i !== sel) });
      setSel(null);
      setEditing(null);
      return;
    }
    if (flip.strokes.length) onChange({ ...flip, strokes: flip.strokes.slice(0, -1) });
    else if (texts.length) onChange({ ...flip, texts: texts.slice(0, -1) });
  };

  return (
    <div>
      <div className="tools">
        <button className="w" data-on={tool === 'text' ? 1 : 0} onClick={() => setTool('text')} disabled={disabled}>
          文字
        </button>
        <button className="w" data-on={tool === 'pen' ? 1 : 0} onClick={() => { setTool('pen'); setEditing(null); }} disabled={disabled}>
          ペン
        </button>
        <span className="sep" />

        {tool === 'pen' ? (
          WIDTHS.map((w) => (
            <button key={w} className="w" data-on={width === w ? 1 : 0} onClick={() => setWidth(w)} disabled={disabled}>
              {w === 1 ? '細' : w === 2 ? '中' : '太'}
            </button>
          ))
        ) : (
          <>
            {FONTS.map((f) => (
              <button
                key={f}
                className="font"
                data-on={(cur?.font ?? font) === f ? 1 : 0}
                style={{ fontFamily: `var(--f-${f})` }}
                onClick={() => { setFont(f); if (sel !== null) patch(sel, { font: f }); }}
                disabled={disabled}
              >
                {FONT_LABEL[f]}
              </button>
            ))}
            <span className="sep" />
            <label className="range" title="文字の大きさ">
              <span>大きさ</span>
              <input
                type="range"
                min={TEXT_MIN}
                max={TEXT_MAX}
                value={cur?.size ?? size}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSize(v);
                  if (sel !== null) patch(sel, { size: v });
                }}
                disabled={disabled}
              />
            </label>
            <label className="range" title="傾き">
              <span>傾き</span>
              <input
                type="range"
                min={-30}
                max={30}
                value={cur?.rot ?? 0}
                onChange={(e) => sel !== null && patch(sel, { rot: Number(e.target.value) })}
                disabled={disabled || sel === null}
              />
            </label>
          </>
        )}

        <span style={{ flex: 1 }} />
        <button className="icon" onClick={undo} disabled={disabled || !dirty} title="1つ戻す" aria-label="1つ戻す">↩</button>
        <button
          className="icon"
          onClick={() => { onChange(emptyFlip()); setSel(null); setEditing(null); }}
          disabled={disabled || !dirty}
          title="全部消す"
          aria-label="全部消す"
        >
          全消
        </button>

        {/* 説明は道具箱の中に置く。フリップの下に出していたころは板の影が
            背景に落ちて、文字にグラデーションが掛かって見えた（styles.css の .tools .hint） */}
        <p className="hint">
          {tool === 'text'
            ? 'フリップをクリックすると中央に文字の箱ができます。掴んで移動、左右の印で幅、角の印で文字ごと拡大縮小。書き直しはダブルクリック。'
            : 'フリップの上をドラッグすると線が引けます。'}
        </p>
      </div>

      <div
        ref={wrap}
        className="board edit"
        style={{ cursor: disabled ? 'default' : tool === 'pen' ? 'crosshair' : 'text', opacity: disabled ? .7 : 1 }}
        onMouseDown={keepFocus}
        onDoubleClick={reopen}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <svg className="ink" viewBox={`0 0 ${FLIP_W} ${FLIP_H}`}>
          <StrokeLayer strokes={flip.strokes} />
        </svg>

        {texts.map((t, i) => (
          <div
            key={i}
            className="tbox"
            data-sel={sel === i ? 1 : 0}
            style={boxStyle(t)}
            onPointerDown={editing === i ? undefined : grabBox(i)}
          >
            {editing === i ? (
              <textarea
                ref={area}
                value={t.text}
                onChange={(e) => patch(i, { text: e.target.value.slice(0, LIMIT.textLen) })}
                onBlur={dropEmpty}
                onPointerDown={(e) => e.stopPropagation()}
                rows={1}
              />
            ) : (
              t.text || '文字を入れる'
            )}
            {sel === i && !disabled && (
              <>
                <span className="grip l" onPointerDown={grabEdge(i, -1)} />
                <span className="grip r" onPointerDown={grabEdge(i, 1)} />
                {/* 角。横の印は折り返す幅だけ、角は文字ごと大きさを変える */}
                <span className="grip c tl" onPointerDown={grabEdge(i, -1, true)} />
                <span className="grip c tr" onPointerDown={grabEdge(i, 1, true)} />
                <span className="grip c bl" onPointerDown={grabEdge(i, -1, true)} />
                <span className="grip c br" onPointerDown={grabEdge(i, 1, true)} />
              </>
            )}
          </div>
        ))}
      </div>

    </div>
  );
}
