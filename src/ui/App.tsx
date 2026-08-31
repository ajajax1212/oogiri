import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { DELAY } from '../engine/reducer';
import { emptyFlip, type Flip, type TopicPhase, type Verdict } from '../engine/types';
import { CAT_LABEL, LIMIT } from '../net/events';
import { codeFromUrl, useRoom } from '../net/useRoom';
import { FlipEditor } from './FlipEditor';
import { FlipView } from './Flip';
import { TopicForm } from './TopicForm';
import { splitTopic, widestOf } from './topicLines';
import { closingPlan, isRush, prefersReduced, RUNGS, seedOf, stepAt, type ClosingPlan } from './closing';
import { play, sfxEnabled, setSfxEnabled, subscribeSfx } from './sound';
import './styles.css';

/** 書きかけはサーバーに置かない。リロードで消えないよう sessionStorage に持つ */
const DRAFT = 'oogiri.draft';
const loadDraft = (): Flip => {
  try {
    const raw = sessionStorage.getItem(DRAFT);
    return raw ? (JSON.parse(raw) as Flip) : emptyFlip();
  } catch { return emptyFlip(); }
};
const saveDraft = (f: Flip) => {
  try { sessionStorage.setItem(DRAFT, JSON.stringify(f)); } catch { /* 諦める */ }
};

/**
 * 書く場所を畳んでいるか。
 *
 * **既定は開いている。** 畳んだかどうかを憶えないと、場面が変わるたびに開き直しになり、
 * 「早い人が矢継ぎ早に回答して書く時間が無い」という元の不満がそのまま残る。
 * 席の合鍵と同じ sessionStorage に置くのは、同じブラウザの別タブ（＝別の人として
 * 動作確認する）に設定を持ち込ませないため。
 */
const DESK = 'oogiri.desk';
const loadDeskOpen = (): boolean => {
  try { return sessionStorage.getItem(DESK) !== '0'; } catch { return true; }
};
const saveDeskOpen = (open: boolean) => {
  try { sessionStorage.setItem(DESK, open ? '1' : '0'); } catch { /* 諦める */ }
};

/** CSS 変数を style に渡すための型。any で通さない */
type Vars = CSSProperties & Record<`--${string}`, string | number>;

export function App() {
  const r = useRoom();
  const [flip, setFlip] = useState<Flip>(loadDraft);
  const v = r.view;

  const setAndSave = (f: Flip) => { setFlip(f); saveDraft(f); };

  // 新しいお題に移ったらフリップを空にする（SPEC.md §4.6）。
  // お題の「文」で見てはいけない。宣言の間は文が伏せられるので、
  // 誰かが回答するたびに全員の書きかけが消えてしまう
  useEffect(() => { setAndSave(emptyFlip()); }, [v?.topicId]); // eslint-disable-line

  // 自分が出した回答は、判定が終わった時点で使い切り
  const mineResolved = v?.topicPhase === 'result' && v.answer?.playerId === v.me;
  useEffect(() => { if (mineResolved) setAndSave(emptyFlip()); }, [mineResolved]); // eslint-disable-line

  // 場面が変わったときの音。App はゲーム中ずっと生きているので、ここで見張る
  useSceneSfx(v);

  if (!v) return <Enter r={r} />;
  if (v.roomPhase === 'lobby') return <Lobby r={r} v={v} />;
  return <Game r={r} v={v} flip={flip} setFlip={setAndSave} />;
}

type R = ReturnType<typeof useRoom>;
type V = NonNullable<R['view']>;

/** 採点の3段。並び順と強調はここだけで決める（ルールの値は engine 側） */
const SCORES: readonly [1 | 2 | 3, string, boolean][] = [
  [1, '小笑い', false],
  [2, '中笑い', false],
  [3, '大笑い', true],
];

/* ------------------------------------------------------------------ 効果音 */

/**
 * 場面の変わり目に音を1回だけ鳴らす（SPEC.md §10.3）。
 *
 * 「今この phase だから鳴らす」にすると、**再接続やリロードで状態を受け直した
 * だけで鳴る**。前に受け取ったものと違うときにだけ鳴らし、いちばん最初の受信は
 * 必ず黙る。見張るのは phase だけでなくお題の id も込み。ロビーでも topicPhase は
 * 何かしらの値を持っているので、phase だけ見ていると開始の一撃を取り逃がす。
 */
function useSceneSfx(v: V | null): void {
  const prev = useRef<{ room: string; phase: string; topicId: string | null } | null>(null);

  useEffect(() => {
    if (!v) return;
    const now = { room: v.roomPhase, phase: v.topicPhase, topicId: v.topicId };
    const was = prev.current;
    prev.current = now;

    if (!was) return;                      // 初回の受信では鳴らさない
    if (v.roomPhase !== 'live') return;    // ロビーは静かに
    const moved = was.phase !== now.phase || was.topicId !== now.topicId;
    if (!moved) return;

    switch (now.phase) {
      case 'intro': play('strike'); break;
      case 'declared': play('declare'); break;
      case 'reveal': play('lift'); break;
      // 最後に押した人はタップ音を鳴らさないので、ここを黙らせると1.2秒の無音になる。
      // 枠が動き出す合図も兼ねているので、ここは今まで通り即座に鳴らす
      case 'tally': play('tally'); break;
      // **判定の音（small/medium/big/perfect）はここでは鳴らさない。**
      // 枠が閉じ切る前に大笑いの声が出るとネタバレになるので、溜めと同じだけ
      // 遅らせて Closing が鳴らす。画と音が別々に時刻を計算しないよう、
      // 溜めの長さは closing.ts の closingPlan だけが決める
      // 判定が終わって板へ戻った合図。**intro からの open では鳴らさない**
      // （直前に strike が鳴っているので重なる）
      case 'open': if (was.phase === 'result') play('resume'); break;
      default: break;                      // stage は無音
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.roomPhase, v?.topicPhase, v?.topicId]);
}

/**
 * 音の入り切り。
 *
 * **押した瞬間が AudioContext を作れる唯一の確実な機会**なので、
 * ここは必ず人の操作から呼ぶ（画面の切り替わりで勝手にオンにしない）。
 */
function SoundToggle() {
  const [on, setOn] = useState(sfxEnabled);
  useEffect(() => subscribeSfx(() => setOn(sfxEnabled())), []);

  return (
    <button
      className="sfx"
      data-on={on ? 1 : 0}
      aria-pressed={on}
      title={on ? '効果音を切る' : '効果音を入れる'}
      onClick={() => setSfxEnabled(!on)}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
        <path d="M4 9h3.5L12 5v14l-4.5-4H4z" fill="currentColor" />
        {on ? (
          <>
            <path d="M15.5 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M18 6.8a7.5 7.5 0 0 1 0 10.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </>
        ) : (
          <path d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        )}
      </svg>
      <span>音</span>
    </button>
  );
}

/* ------------------------------------------------------------------ お題の板 */

/**
 * 新しいお題の全画面（topicPhase === 'intro'）。
 * 黄一色 + 上下の黒帯 + 極太の黒文字だけで作る。読み切るための時間なので、
 * 押せるものは一切置かない。
 */
function TopicPlate({ text, deadline, out }: { text: string; deadline: number | null; out?: boolean }) {
  const lines = splitTopic(text);

  // 残り時間の線の長さ。サーバーが持っている締切から「今からの残り」を1度だけ出す。
  // クライアント側で時間を進めない（setInterval を持たない）ので、
  // ここで測るのは描画開始の瞬間だけ。以降は CSS のアニメが尺を持つ。
  //
  // **この引き算は端末の時計を信じている。** 時計がサーバーより遅れていると
  // 残りが実際より長く出て、線が途中のまま画面が切り替わる。お題の尺そのもの
  // （DELAY.intro）を超えることは原理的に無いので、そこで頭を押さえる。
  // こうしておくと、ずれても線は「早く終わって満ちたまま待つ」側にしか転ばない
  const [dur] = useState(() => {
    const left = deadline === null ? DELAY.intro : deadline - Date.now();
    return Math.round(Math.max(0, Math.min(DELAY.intro, left)));
  });

  const vars: Vars = { '--n': widestOf(lines), '--l': lines.length, '--dur': `${dur}ms` };

  return (
    <div className={`intro${out ? ' out' : ''}`} style={vars} aria-live="polite">
      <div className="bar top">
        <span className="no">お 題</span>
      </div>

      <div className="lines">
        {lines.map((l, i) => (
          <span key={i} style={{ '--i': i } as Vars}>{l}</span>
        ))}
      </div>

      <div className="bar bottom">
        {/* 番組のロゴは使わない。名乗るのはこのゲーム自身の名前だけ */}
        <span className="brand">大喜利<em>OOGIRI</em></span>
        <span className="no">フリップに書いてください</span>
        {!out && <span className="tick" />}
      </div>
    </div>
  );
}

/**
 * ボード画面の上に居座るお題。書いている最中でも常に読めるよう sticky。
 *
 * ここも行を自分で割る。CSS の折り返しに任せると、狭い画面で
 * 「どこ／がすごい？」のように語の途中で折れて読みにくい。
 */
function TopicStrip({ text }: { text: string }) {
  const lines = splitTopic(text, 2, 20);
  const vars: Vars = { '--n': widestOf(lines) };
  return (
    <div className="strip" style={vars}>
      <span className="tag">お題</span>
      <b>{lines.map((l, i) => <span key={i}>{l}</span>)}</b>
    </div>
  );
}

/**
 * intro を抜けた後も一瞬だけ幕を残し、上へめくって下の盤面を見せる。
 * 進行はサーバーが決めた通りで、ここが持つのは見送りの 0.42 秒だけ。
 * めくれている間は pointer-events を切ってあるので、下のボタンは最初から押せる。
 */
function useLingering(active: boolean, ms: number): boolean {
  const [linger, setLinger] = useState(false);
  const prev = useRef(active);
  useEffect(() => {
    const was = prev.current;
    prev.current = active;
    if (was && !active) {
      setLinger(true);
      const t = window.setTimeout(() => setLinger(false), ms);
      return () => window.clearTimeout(t);
    }
  }, [active, ms]);
  return linger;
}

/* ------------------------------------------------------------------ 入口 */

function Enter({ r }: { r: R }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(codeFromUrl() ?? '');
  const joining = !!codeFromUrl();

  return (
    <div className="app">
      <div className="title">
        <span className="plaque">大喜利</span>
        <p>
          {joining
            ? '呼ばれた部屋です。名前を入れて入ってください。'
            : 'お題は自動で出ます。フリップに書いて、名乗り出てください。'}
        </p>
      </div>
      <div className="card col" style={{ maxWidth: 460, margin: '0 auto' }}>
        {/* 招待URLから来た人には行き先を見せる。どの部屋に入るのか分からないまま押させない */}
        {joining && (
          <p className="invited">
            部屋 <strong>{code}</strong> に招待されています
          </p>
        )}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`名前（${LIMIT.name}文字まで）`} />
        {!joining && (
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="部屋コード（入るとき）" />
        )}
        {/* 招待から来た人に「部屋を作る」は要らない。押されると誰も居ない部屋ができるだけ */}
        {joining ? (
          <button
            className="gold big"
            onClick={() => r.enter('join', name, code)}
            disabled={!name.trim()}
          >
            部屋に入る
          </button>
        ) : (
          <div className="row">
            <button className="gold" onClick={() => r.enter('create', name)} disabled={!name.trim()}>
              部屋を作る
            </button>
            <button onClick={() => r.enter('join', name, code)} disabled={!name.trim() || !code.trim()}>
              部屋に入る
            </button>
          </div>
        )}
        <p className="err">{r.error}</p>
        {!r.connected && <p className="muted">サーバーに接続しています…</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ ロビー */

function Lobby({ r, v }: { r: R; v: V }) {
  const [word, setWord] = useState('');
  const [cat, setCat] = useState<keyof typeof CAT_LABEL>('person');
  const me = v.players.find((p) => p.id === v.me);
  const mine = v.brought.filter((b) => b.mine).length;
  const url = `${location.origin}/g/${v.code}`;

  return (
    <div className="app">
      <div className="title" style={{ padding: '26px 0 20px' }}>
        <span className="plaque" style={{ fontSize: 'clamp(30px, 5vw, 46px)' }}>大喜利</span>
      </div>

      <div className="card col">
        <div className="row">
          <strong className="code">{v.code}</strong>
          <button onClick={() => navigator.clipboard?.writeText(url)}>招待リンクをコピー</button>
          <span className="muted" style={{ fontSize: 13 }}>この URL がそのまま招待状です</span>
        </div>

        <div className="row">
          {v.players.map((p) => (
            <span key={p.id} className="seat" data-off={p.connected ? 0 : 1}>
              {p.name}
              {p.isHost && <span className="host">ホスト</span>}
              {me?.isHost && !p.connected && p.id !== v.me && (
                <button style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => r.kick(p.id)}>席を空ける</button>
              )}
            </span>
          ))}
        </div>

        <div className="hr" />

        <div>
          <div className="sec">今日の言葉</div>
          <p className="muted" style={{ margin: '8px 0 12px', fontSize: 14 }}>
            1人1語は必ず、多くて{LIMIT.wordsPerPlayer}語まで。ここで入れた言葉がお題の材料に混ざります。
            誰が入れたかは出ません。
          </p>
          <div className="row">
            <input
              value={word}
              onChange={(e) => setWord(e.target.value.slice(0, LIMIT.wordLen))}
              onKeyDown={(e) => e.key === 'Enter' && word.trim() && r.addWord(word, cat).then((x) => x.ok && setWord(''))}
              placeholder={`言葉（${LIMIT.wordLen}文字まで）`}
              style={{ width: 220 }}
            />
            {(Object.keys(CAT_LABEL) as (keyof typeof CAT_LABEL)[]).map((c) => (
              <button key={c} className="w" data-on={cat === c ? 1 : 0} style={{ width: 'auto', padding: '8px 14px' }} onClick={() => setCat(c)}>
                {CAT_LABEL[c]}
              </button>
            ))}
            <button
              onClick={() => r.addWord(word, cat).then((x) => x.ok && setWord(''))}
              disabled={!word.trim() || mine >= LIMIT.wordsPerPlayer}
            >
              入れる
            </button>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {v.brought.map((b) => (
              <span key={b.id} className="chip">
                {b.word}
                {(b.mine || me?.isHost) && (
                  <button onClick={() => r.removeWord(b.id)}>×</button>
                )}
              </span>
            ))}
            {!v.brought.length && <span className="muted">まだ誰も入れていません</span>}
          </div>
        </div>

        <div className="hr" />

        <div>
          <div className="sec">オリジナルのお題を追加する</div>
          <div style={{ marginTop: 10 }}>
            <TopicForm myTopics={v.myTopics} count={v.handmadeCount} post={r.postTopic} remove={r.removeTopic} />
          </div>
        </div>

        <div className="hr" />
        <div className="row">
          {me?.isHost ? (
            <button className="gold" style={{ padding: '14px 40px', fontSize: 18 }} onClick={() => r.startGame()}>始める</button>
          ) : (
            <span className="muted">ホストが始めるのを待っています</span>
          )}
          <button onClick={() => r.leave()}>抜ける</button>
          <span style={{ flex: 1 }} />
          <SoundToggle />
        </div>
        <p className="err">{r.error}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 本番 */

function Game({ r, v, flip, setFlip }: { r: R; v: V; flip: Flip; setFlip: (f: Flip) => void }) {
  const me = v.players.find((p) => p.id === v.me);
  const iAnswer = v.answer?.playerId === v.me;
  const canWrite = !iAnswer;
  const empty = !flip.strokes.length && !flip.texts.length;
  const leavingIntro = useLingering(v.topicPhase === 'intro', 420);
  // 自分が押したら採点が揃うか。scored は自分の分を含まない数
  const lastJudge = !!v.answer && v.answer.scored + 1 >= v.answer.judges;

  // 畳んだかどうかは人の判断なので憶えておく。**場面ごとに開き直させない。**
  // open は書くための場面なので、畳んでいても必ず出す
  const [deskOpen, setDeskOpen] = useState(loadDeskOpen);
  const deskShown = v.topicPhase === 'open' || deskOpen;
  const foldDesk = (open: boolean) => { setDeskOpen(open); saveDeskOpen(open); };

  // 書いている最中かどうか。**画面の頭へ戻すかどうかの判断にしか使わない**ので、
  // 変わっても描き直す必要が無い（state ではなく ref）
  const writing = useRef(false);
  const onActivity = (w: boolean) => { writing.current = w; r.setWriting(w); };

  // 場面が変わったら画面の頭へ戻す。前の場面のスクロール位置が残っていると、
  // 次の場面が画面の外から始まり「何も出ていない」ように見える（実際に見た）。
  // ただし**書いている最中は動かさない**。下書きは演出の下に置いてあるので、
  // 誰かが回答するたびに手元が画面外へ飛ぶことになる
  useEffect(() => {
    if (writing.current) return;
    window.scrollTo({ top: 0 });
  }, [v.topicPhase, v.topicId]);

  const clock = useRevealClock(v);
  const answerKey = `${v.topicId ?? '-'}|${v.answer?.playerId ?? '-'}`;

  // 回答権は先着1人・open のときだけ（SPEC.md §5.1）。**この条件は変えない。**
  // 押せない理由は必ず画面に出す。黙って灰色のボタンだと、
  // 自分の書きかけが足りないのか他人が回答中なのかが分からない
  const claimable = v.topicPhase === 'open' && !v.answer && !empty;
  const why = v.answer
    ? iAnswer
      ? 'あなたの回答を出しています'
      : `${v.answer.playerName} さんの回答中`
    : v.topicPhase !== 'open'
      ? 'お題を待っています'
      : empty
        ? 'フリップに何か書くと押せます'
        : '';

  return (
    <div className="app game" data-phase={v.topicPhase} data-desk={deskShown ? 1 : 0}>
      {/* declared のあいだサーバーは文を伏せる（v.topic が null）ので、帯は勝手に消える */}
      {v.topic && v.topicPhase !== 'intro' && <TopicStrip text={v.topic} />}

      <div className="floor">
        <div className="main">
          {/* 場の主役。ここだけが場面ごとに中身を入れ替える */}
          <div className="show">
            {v.topicPhase === 'declared' && (
              <div className="declare">
                <div>
                  <b>{v.answer?.playerName} さんが回答します</b>
                  <div className="rule" />
                  <small>この あと 公開</small>
                </div>
              </div>
            )}

            {v.topicPhase === 'stage' && (
              <div className="wait">
                {iAnswer ? (
                  <button className="gold reveal-btn" onClick={() => r.reveal()}>公開する</button>
                ) : (
                  <span>{v.answer?.playerName} さんが公開するのを待っています</span>
                )}
              </div>
            )}

            {v.topicPhase === 'reveal' && v.answer?.flip && (
              <>
                <Reveal flip={v.answer.flip} name={v.answer.playerName} />
                {iAnswer ? (
                  <p className="done">採点を待っています　<b>{v.answer.scored} / {v.answer.judges}</b> 人</p>
                ) : v.answer.iScored ? (
                  <p className="done">採点しました　<b>{v.answer.scored} / {v.answer.judges}</b> 人</p>
                ) : (
                  <div className="scores">
                    {SCORES.map(([value, label, hot]) => (
                      <button
                        key={value}
                        className={hot ? 'gold' : ''}
                        onClick={() => {
                          // **発表につながるタップは無音にする。** 最後の1人が押すと
                          // そのまま集計→判定へ進むので、タップ音と判定の音が重なって
                          // 濁る（senryu-game で一度そうなった）。判定の音が返事になる
                          if (!lastJudge) play('tap');
                          void r.score(value);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* 集計と判定は1つの画面。**フリップを消して出し直さない。**
                tally で「集計中…」の全画面を挟むと、公開で起こした板が一度消える。
                key を回答ごとに切るのは、2人目の回答で必ず頭から流し直すため */}
            {(v.topicPhase === 'tally' || v.topicPhase === 'result') && v.answer && (
              <Closing
                key={answerKey}
                a={v.answer}
                topicId={v.topicId}
                phase={v.topicPhase}
                deadline={v.deadline}
                clock={clock}
              />
            )}
          </div>

          {/*
            書く場所は**どの場面でも同じ場所に居座る**（SPEC.md §3.2）。
            open のときだけ出す作りだと、誰かが回答してから判定が終わるまで
            書く場所が消え、早い人が続けて回答すると書く時間がほとんど無くなる。

            **DOM 上の位置を場面で動かさない**のが肝。動かすと React が
            FlipEditor を作り直し、打っている途中でキャレットと選択中の箱が飛ぶ。
          */}
          <section className="desk">
            <div className="bar">
              <span className="ttl">自分のフリップ</span>
              <span className="st">{why || '書けます'}</span>
              <button className="fold" aria-expanded={deskShown} onClick={() => foldDesk(!deskOpen)}>
                {deskShown ? '畳む' : '書く'}
              </button>
            </div>

            {deskShown && (canWrite ? (
              <>
                <FlipEditor flip={flip} onChange={setFlip} onActivity={onActivity} />
                <div className="act">
                  <button className="gold" disabled={!claimable} onClick={() => r.claim(flip)}>
                    回答する
                  </button>
                  {/* サーバーが断った理由をここに出す。ロビーには出しているのに
                      本番の画面だけ握り潰していたので、「押しても何も起きない
                      ボタン」になっていた（実際に動作確認で踏んだ） */}
                  {r.error ? <p className="err">{r.error}</p> : why && <p className="why">{why}</p>}
                </div>
              </>
            ) : (
              // 回答者だけは書けない。判定が終わるとこの書きかけは使い切りになる
              <p className="why">あなたの回答が場に出ています。判定が終わるまで待ってください</p>
            ))}
          </section>

          <details className="extra">
            <summary>オリジナルのお題を追加する（{v.handmadeCount}問たまっています）</summary>
            <div className="card" style={{ marginTop: 12 }}>
              <TopicForm myTopics={v.myTopics} count={v.handmadeCount} post={r.postTopic} remove={r.removeTopic} />
            </div>
          </details>
        </div>

        {/*
          プレイヤー一覧は右の固定幅の列。下の帯に横並びだったころは、
          「書いています」が何人も点いたり消えたりするたびに折り返しが変わって
          帯の高さごとチラついた。**幅を固定し、印の行に常に高さを持たせて**
          出入りしても何も動かないようにしてある
        */}
        <aside className="side">
          <div className="who">
            {v.players.map((p) => (
              <span key={p.id} className="seat" data-off={p.connected ? 0 : 1} data-ready={p.ready ? 1 : 0}>
                <b className="nm">{p.name}</b>
                <span className="st">
                  {p.perfects > 0 && <span className="p">満点 {p.perfects}</span>}
                  {/* 誰がホストかは進行中も要る。抜けると次の人へ渡るので、
                      ロビーで見た顔ぶれのまま憶えていると当てにならない */}
                  {p.isHost && <span className="host">ホスト</span>}
                  {p.writing && <span className="w">書いています</span>}
                  {!p.connected && <span className="w">切断中</span>}
                </span>
              </span>
            ))}
          </div>
        </aside>
      </div>

      {/* 新しいお題は全画面で数秒。読み切ってからボードへ移る（SPEC.md §3.2）。
          **盤面と入れ替えず上に被せる。** 入れ替えると下の FlipEditor が
          お題のたびに作り直され、書きかけの箱の選択が毎回外れる */}
      {v.topicPhase === 'intro' && (
        <TopicPlate key={v.topicId ?? 'intro'} text={v.topic ?? ''} deadline={v.deadline} />
      )}
      {/* サーバーはもう次の画面に進んでいる。ここに残っているのは幕がめくれる 0.42 秒だけ */}
      {leavingIntro && <TopicPlate key="outro" text={v.topic ?? ''} deadline={null} out />}

      <div className="dock">
        <div className="inner">
          <SoundToggle />
          {me?.isHost && <button onClick={() => r.toLobby()}>ロビーへ</button>}
          <LeaveButton onLeave={() => r.leave()} />
          {/* 進行のボタンだけを右端へ寄せる。狭い画面ではこの隙間を畳んで
              行を空ける（@media が display: none にする） */}
          <span className="grow" />
          <button
            className={`agree${me?.ready ? '' : ' gold'}`}
            onClick={() => r.setReady(!me?.ready)}
          >
            {v.agree === 'reroll' ? 'お題を引き直す' : '次のお題に行く'}（{v.readyCount} / {v.aliveCount}人）
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 部屋から抜ける。
 *
 * **一度確認を挟む。** 下の帯は連打される場所なので、押し間違いで席を捨てると
 * 書きかけごと消える。別ウィンドウ（confirm）を出さないのは、
 * ゲーム中に焦点を奪われると進行中の演出が止まって見えるため。
 * その場でラベルが変わるだけにしてある。
 */
function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    // 確認したまま忘れると、次に触ったときに問答無用で抜けることになる。
    // 数秒で元へ戻すのが、別ウィンドウを出さない代わりの安全弁
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={`leave${armed ? ' danger' : ''}`}
      onClick={() => (armed ? onLeave() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? 'ほんとに抜ける？' : '抜ける'}
    </button>
  );
}

/**
 * 公開の見せ場（SPEC.md §10.2）。「ためて・出して・止める」の3拍。
 *
 * 尺は効果音 lift の波形に合わせてある（頭 0.16 秒がほぼ無音の立ち上がり、
 * 0.16〜0.24 秒が一撃、そこから 0.5 秒で落ちる）。**画を音より先に完成させると、
 * 音が後追いの拍手のように聞こえる**ので、板が上がり切る瞬間を音の頂点へ置いた。
 * 実際の数字は styles.css の @keyframes hoist 側にある（音の表は触らない）。
 *
 * 飾りの3枚を JSX に置いたのは、板の ::before / ::after が使えないため。
 * 板は overflow: hidden なので、疑似要素で光らせると板の内側で切られて
 * 「板の外へ漏れる光」にならない。並び順そのものが重なりの順序になっている。
 *
 * key を付けていないのは、phase が reveal を外れるとこの木ごと消えるから。
 * 2人目の公開でも必ず頭から流れ直す。
 */
function Reveal({ flip, name }: { flip: Flip; name: string }) {
  return (
    <div className="reveal">
      {/* 出どころを先に示す。暗闇からいきなり白が出ると、ためが単なる空白に見える */}
      <div className="spot" aria-hidden="true" />
      <div className="slit" aria-hidden="true" />
      {/* 閃光は板より前に置く。板は position: relative なので後から描かれ、
          光は板の縁からはみ出した分だけが見える（styles.css の .reveal .flash） */}
      <div className="flash" aria-hidden="true" />
      <FlipView flip={flip} lift />
      {/* 名前は板が止まってから。同時に出すと視線が2つに割れる */}
      <p className="by"><span>{name}</span> さんの回答</p>
    </div>
  );
}

/* ------------------------------------------------------------------ 決着 */

/**
 * `reveal` に入った時刻を憶えておく箱。
 *
 * **サーバーは経過時間を配らない**ので、「採点が速かったか」はここでしか測れない。
 * state ではなく ref に置くのは、この値が変わっても描き直す必要が無いから。
 *
 * 読むのは Closing が mount した瞬間。**子の effect は親の effect より先に走る**ので、
 * Closing が mount する commit ではまだ1つ前の commit の値（phase は 'reveal'）が
 * 入っている。これがそのまま「reveal から続けて来たか」の判定になる。
 */
type RevealClock = { phase: TopicPhase | null; key: string; revealAt: number | null };

function useRevealClock(v: V): RefObject<RevealClock> {
  const clock = useRef<RevealClock>({ phase: null, key: '', revealAt: null });
  const key = `${v.topicId ?? '-'}|${v.answer?.playerId ?? '-'}`;

  useEffect(() => {
    const c = clock.current;
    // 回答が変わったら測り直す。前の回答の時刻を持ち越すと、
    // 2人目の公開がいきなり「速い」と誤判定される
    if (c.key !== key) { c.key = key; c.revealAt = null; }
    if (v.topicPhase === 'reveal' && c.phase !== 'reveal') c.revealAt = Date.now();
    c.phase = v.topicPhase;
  }, [v.topicPhase, key]);

  return clock;
}

const SIDES = ['t', 'r', 'b', 'l'] as const;
type Side = (typeof SIDES)[number];

/** 段 → 枠が食い込む割合。12段で 50%（＝板の中央）に届いて閉じ切る */
const cover = (step: number) => (step / RUNGS) * 50;

/**
 * 覆う側だけを見せる。
 *
 * **バーは板と同じ大きさで固定しておき、clip-path で見える範囲だけ広げる。**
 * バーそのものを伸ばすと、中に敷いた段の模様まで一緒に伸び縮みして、
 * 段が段に見えない（切れ目が動く）。clip-path なら模様は動かない。
 */
function barStyle(s: Side, step: number): CSSProperties {
  // 角は 45度ではなく「4辺が同じ割合で迫った先」で継ぐ。額縁と同じ留め継ぎになり、
  // 深く入っても縞の向きが角でぶつからない。矩形で重ねると、角が
  // 縦縞と横縞の市松になって「枠」に見えなくなる（実際にそうなった）
  const c = cover(step);
  const a = `${c}%`;
  const z = `${100 - c}%`;
  if (s === 't') return { clipPath: `polygon(0 0, 100% 0, ${z} ${a}, ${a} ${a})` };
  if (s === 'b') return { clipPath: `polygon(0 100%, ${a} ${z}, ${z} ${z}, 100% 100%)` };
  if (s === 'l') return { clipPath: `polygon(0 0, ${a} ${a}, ${a} ${z}, 0 100%)` };
  return { clipPath: `polygon(100% 0, 100% 100%, ${z} ${z}, ${z} ${a})` };
}

/** 最前列の光。まだ空いている窓の縁を1周する */
function edgeStyle(s: Side, step: number): CSSProperties {
  const a = `${cover(step)}%`;
  if (s === 't') return { top: a, left: a, right: a };
  if (s === 'b') return { bottom: a, left: a, right: a };
  if (s === 'l') return { left: a, top: a, bottom: a };
  return { right: a, top: a, bottom: a };
}

/** 判定の音。'none'（採点者が居なかった）は鳴らさない。知らせる出来事が無い */
function playVerdict(verdict: Verdict): void {
  if (verdict === 'perfect') play('perfect');
  else if (verdict === 'big') play('big');
  else if (verdict === 'medium') play('medium');
  else if (verdict === 'small') play('small');
}

/**
 * 集計から判定までを一続きに見せる（SPEC.md §6・§10.2）。
 *
 * フリップは公開のときのまま置き、**上に重ねた金の枠だけが段階的に迫る**。
 * 板は container-type: inline-size で中の文字が cqw で効くので、板の幅を
 * 動かすと文字まで動く。だから板には一切触らない。
 *
 * 尺と段数は closing.ts の closingPlan が1つだけ決める。画も音も同じ計画を読む。
 */
function Closing({ a, topicId, phase, deadline, clock }: {
  a: NonNullable<V['answer']>;
  topicId: string | null;
  phase: 'tally' | 'result';
  deadline: number | null;
  clock: RefObject<RevealClock>;
}) {
  const verdict: Verdict = a.tally?.verdict ?? 'none';

  // mount した1回だけ決める。誰かの writing が変わって再描画されても作り直さない
  const [run] = useState<{ plan: ClosingPlan; elapsed: number; armed: boolean }>(() => {
    const c = clock.current;
    // reveal からそのまま繋がったときだけ音を鳴らす。**リロードや再接続で
    // 状態を受け直しただけで鳴ってはいけない**（SPEC.md §10.3）
    const armed = phase === 'tally' && c.phase === 'reveal';

    // 途中から入った人のために、枠がどこまで来ているはずかを deadline から出す。
    // **この引き算は端末の時計を信じている**ので、必ず DELAY で頭を押さえる
    // （CLAUDE.md）。押さえないと、時計のずれた端末で枠が最初から出直す
    const span = phase === 'tally' ? DELAY.tally : DELAY.result;
    const base = phase === 'tally' ? 0 : DELAY.tally;
    const left = deadline === null ? span : deadline - Date.now();
    const elapsed = base + Math.max(0, Math.min(span, span - left));

    return {
      plan: closingPlan({
        verdict,
        // 同じ回答なら誰の画面でも同じ間で止まる（closing.ts の seedOf）
        seed: seedOf(a.playerId, topicId, verdict),
        rush: isRush(c.revealAt === null ? null : Date.now() - c.revealAt, a.judges),
        reduced: prefersReduced(),
      }),
      elapsed,
      armed,
    };
  });

  const { plan, elapsed, armed } = run;
  const [step, setStep] = useState(() => stepAt(plan, elapsed));
  const [shown, setShown] = useState(() => elapsed >= plan.verdictAt);

  useEffect(() => {
    const timers: number[] = [];
    plan.at.forEach((ms, i) => {
      if (ms <= elapsed) return;          // もう過ぎている段にはタイマーを張らない
      timers.push(window.setTimeout(() => setStep(i + 1), ms - elapsed));
    });
    if (plan.verdictAt > elapsed) {
      timers.push(window.setTimeout(() => {
        setShown(true);
        if (armed) playVerdict(verdict);
      }, plan.verdictAt - elapsed));
    }
    // **張ったタイマーは必ず片付ける。** 残すと、次の回答へ進んだ後に
    // 前の回答の判定の音が遅れて鳴る（同じ音が二重に鳴る）
    return () => { for (const t of timers) window.clearTimeout(t); };
  }, [plan, elapsed, armed, verdict]);

  return (
    <div className="closing" data-step={step} data-odd={step % 2} data-full={step >= RUNGS ? 1 : 0}>
      <div className="stage">
        {a.flip && <FlipView flip={a.flip} />}
        {/* 枠は板の外周に重ねる層だけで作る。板の中身（線と文字）は触らない */}
        <div className="frame" aria-hidden="true">
          {SIDES.map((s) => <i key={s} className={`bar ${s}`} style={barStyle(s, step)} />)}
          {SIDES.map((s) => <i key={`e${s}`} className={`edge ${s}`} style={edgeStyle(s, step)} />)}
          {/* 段が上がった瞬間の当たり。key を段に取ってあるので、段が変わるたびに
              要素ごと作り直されてアニメが頭から流れ直す（CSS には
              「属性が変わったら流し直す」が無い） */}
          {step > 0 && <i className="hit" key={step} />}
        </div>
      </div>
      <p className="by"><span>{a.playerName}</span> さんの回答</p>
      {shown && <Verdict a={a} />}
    </div>
  );
}

/**
 * 判定。**画面の中央**に出す（枠が止まってから）。
 *
 * 板の白と枠の金の上に重なるので、暗い盤を1枚敷いて金の文字を置く。
 * 満点大笑いだけは今まで通り別格の全画面（.verdict.perfect）。
 */
function Verdict({ a }: { a: NonNullable<V['answer']> }) {
  const t = a.tally;
  if (!t) return null;
  const label = { small: '小笑い', medium: '中笑い', big: '大笑い', perfect: '満点大笑い', none: '判定なし' }[t.verdict];
  const perfect = t.verdict === 'perfect';
  return (
    <div className={`vstage${perfect ? ' perfect' : ''}`} aria-live="polite">
      <div className={`verdict${perfect ? ' perfect' : ''}`}>
        <b>{label}</b>
        {t.judges > 0 && (
          <p className="counts">小 {t.counts[1]}　中 {t.counts[2]}　大 {t.counts[3]}</p>
        )}
      </div>
    </div>
  );
}
