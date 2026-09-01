import { useEffect, useMemo, useState } from 'react';
import type { GalleryEntry } from '../engine/types';
import { VERDICT_TEXT } from '../engine/view';
import { FlipView } from './Flip';

/**
 * その晩に出た回答の見返し（2026-09-01）。
 *
 * **画面を1枚増やすのではなく、今の画面に被せる層にした。** 大喜利には川柳の
 * 「総合結果」に当たる終わりの画面が無く（点を出さないゲームなので）、置ける先が
 * どこにも無い。phase を進めるのはサーバーだけなので、こちらが画面を差し替えると
 * 裏の進行が見えなくなるだけで、止まりはしない。**被せる層なら、下の盤面（と
 * 書きかけの FlipEditor）を mount したまま残せる**ので、閉じれば今の場面に戻る。
 *
 * 板（.board）には transform も font-size も掛けない。板は container-type:
 * inline-size で中の文字が cqw で効くので、**外側の幅を絞るだけで中身ごと相似に
 * 縮む**。一覧の升目と拡大の枠で幅だけを変えている。
 */

type Group = { topicId: string; topic: string; entries: GalleryEntry[] };

/**
 * お題ごとにまとめる。
 *
 * 組は **`topicId` で作る。文で突き合わせない。** たまたま同じ文のお題が続いたときに、
 * 別のお題の回答が1つの組に混ざる。id を分解して topicId を取り出す手もあるが、
 * それだと id の書式が画面側の前提になり、engine で採番を変えた瞬間に黙って壊れる。
 *
 * 隣だけを見るのは、gallery が確定した順に並んでいるため。同じお題の回答は必ず続く。
 */
function groupByTopic(entries: readonly GalleryEntry[]): Group[] {
  const out: Group[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.topicId === e.topicId) last.entries.push(e);
    else out.push({ topicId: e.topicId, topic: e.topicText, entries: [e] });
  }
  return out;
}

/** 内訳の1行。判定なし（採点者が0人だった回答）には出す数が無い */
function Counts({ t }: { t: GalleryEntry['tally'] }) {
  if (t.judges === 0 || t.verdict === 'none') return null;
  return (
    <span className="cnt">
      小 {t.counts[1]}　中 {t.counts[2]}　大 {t.counts[3]}
    </span>
  );
}

/**
 * 一覧の1枚。
 *
 * button にしてあるのは、拡大が「押して開くもの」だから。div + onClick だと
 * Tab で辿れず、狭い画面で拡大を開く手段が指しか無くなる。
 */
function Tile({ e, onOpen }: { e: GalleryEntry; onOpen: () => void }) {
  return (
    <button className="gal-tile" data-v={e.tally.verdict} onClick={onOpen}>
      {/* 枠の高さを CSS（16:10）で決めておく。中身の描画を後回しにしても
          高さが変わらないので、スクロール中に下の升目が飛び跳ねない */}
      <div className="frame">
        <FlipView flip={e.flip} />
      </div>
      <span className="cap">
        <b className="nm">{e.playerName}</b>
        <span className="v">{VERDICT_TEXT[e.tally.verdict]}</span>
      </span>
    </button>
  );
}

/**
 * 選んだ1枚を大きく見る層。
 *
 * 一覧の上にもう1枚重ねる（一覧を消して差し替えない）。差し替えると閉じたときに
 * 一覧のスクロール位置が頭へ戻り、数十枚たまった後で「さっき見ていた場所」に
 * 帰れなくなる。
 */
function Focus({
  e, index, total, onMove, onClose,
}: {
  e: GalleryEntry;
  index: number;
  total: number;
  onMove: (d: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="gal-focus"
      role="dialog"
      aria-modal="true"
      aria-label="回答を大きく見る"
      // 板の外を押したら閉じる。閉じるボタンまで指を運ばせない
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
    >
      <div className="box">
        <p className="topic">{e.topicText}</p>
        <div className="big">
          <FlipView flip={e.flip} />
        </div>
        <p className="meta">
          <b className="nm">{e.playerName}</b>
          <span className="v" data-v={e.tally.verdict}>{VERDICT_TEXT[e.tally.verdict]}</span>
          <Counts t={e.tally} />
        </p>
        <div className="nav">
          <button onClick={() => onMove(-1)} disabled={total < 2}>← 前の回答</button>
          <span className="n">{index + 1} / {total}</span>
          <button onClick={() => onMove(1)} disabled={total < 2}>次の回答 →</button>
          <button className="gold" onClick={onClose}>一覧へ戻る</button>
        </div>
      </div>
    </div>
  );
}

export function Gallery({
  entries, status, onClose,
}: {
  entries: readonly GalleryEntry[];
  /** 裏で進んでいる場面。見ている人が「戻る頃合い」を自分で決められるようにする */
  status?: string;
  onClose: () => void;
}) {
  // 新しい順を既定にする。遊んでいる最中に開く動機は「さっきのあれ何だっけ」で、
  // 探しているのはたいてい直前のお題。あとから通しで読みたい人のために古い順も残す
  const [newest, setNewest] = useState(true);
  // 拡大しているのは id で憶える。**位置（index）で持ってはいけない。**
  // 見ている間にも裏で判定が確定して entries が伸びるので、新しい順では
  // 番号が全部ずれて、見ていた札が別の札にすり替わる
  const [focus, setFocus] = useState<string | null>(null);
  // 開いた時点の枚数。増えた分を知らせるためだけに使う（再描画は不要なので初期値で固定）
  const [seen] = useState(entries.length);

  const groups = useMemo(() => {
    const g = groupByTopic(entries);
    // **組の中は並べ替えない。** 1つのお題の中は出た順に読むのが自然で、
    // 会話の流れ（前の回答を受けた回答）がそのまま残る。入れ替えるのはお題の並びだけ
    return newest ? [...g].reverse() : g;
  }, [entries, newest]);

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const at = focus === null ? -1 : flat.findIndex((e) => e.id === focus);
  const shown = at >= 0 ? flat[at] : null;

  const move = (d: 1 | -1) => {
    if (at < 0 || flat.length === 0) return;
    // 端で止めずに回す。数十枚を順に眺めるとき、端で押せなくなると手が止まる
    setFocus(flat[(at + d + flat.length) % flat.length].id);
  };

  // Esc で1段ずつ閉じ、矢印で送る。**入力欄に居るときは何もしない**。
  // 下の盤面には書きかけの FlipEditor が mount したまま残っていて、
  // 焦点が textarea にあることがある（そこで矢印を奪うと文字が打てなくなる）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target;
      if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      // Esc は一度に1枚だけ畳む。拡大したまま閉じると、次に開いたときに
      // 一覧ではなく前の1枚から始まったように見える
      if (ev.key === 'Escape') {
        if (focus === null) onClose();
        else setFocus(null);
        return;
      }
      if (focus === null) return;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); move(1); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, flat, onClose]);

  const perfects = entries.filter((e) => e.tally.verdict === 'perfect').length;
  const fresh = entries.length - seen;

  return (
    <div className="gal" role="dialog" aria-modal="true" aria-label="今夜の回答">
      <div className="gal-head">
        <span className="ttl">今夜の回答</span>
        <span className="n">
          {entries.length}枚 ・ {groups.length}問
          {perfects > 0 && <em> ・ 満点 {perfects}</em>}
        </span>
        {/* 開いている間に増えた分。裏で進んでいることが一目で分かる */}
        {fresh > 0 && <span className="fresh">＋{fresh}</span>}
        <span className="grow" />
        {entries.length > 0 && (
          <span className="sort">
            <button data-on={newest ? 1 : 0} onClick={() => setNewest(true)}>新しい順</button>
            <button data-on={newest ? 0 : 1} onClick={() => setNewest(false)}>古い順</button>
          </span>
        )}
        <button className="gold" onClick={onClose}>閉じる</button>
      </div>

      {status && <p className="gal-live">進行中　{status}</p>}

      <div className="gal-body">
        {entries.length === 0 ? (
          <div className="gal-empty">
            <b>まだ1枚もありません</b>
            <p>
              回答の判定が出るたびに、ここに1枚ずつ溜まっていきます。
              ロビーへ戻っても消えないので、その晩ぶんをあとからまとめて見返せます。
            </p>
          </div>
        ) : (
          groups.map((g) => (
            <section className="gal-group" key={`${g.entries[0].id}`}>
              <div className="gal-topic">
                <span className="tag">お題</span>
                <b>{g.topic}</b>
                <span className="n">{g.entries.length}枚</span>
              </div>
              <div className="gal-grid">
                {g.entries.map((e) => (
                  <Tile key={e.id} e={e} onOpen={() => setFocus(e.id)} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {shown && (
        <Focus
          e={shown}
          index={at}
          total={flat.length}
          onMove={move}
          onClose={() => setFocus(null)}
        />
      )}
    </div>
  );
}

/** 見返しの入口。ロビーと下の帯で同じ見た目にしたいので、ここに1つだけ置く */
export function GalleryButton({ n, onOpen, className }: { n: number; onOpen: () => void; className?: string }) {
  return (
    <button className={className} onClick={onOpen} title="その晩に出た回答を見返す">
      見返す{n > 0 && <b className="gal-n">{n}</b>}
    </button>
  );
}
