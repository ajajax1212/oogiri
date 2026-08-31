import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DELAY } from '../engine/reducer';
import { emptyFlip, type Flip } from '../engine/types';
import { CAT_LABEL, LIMIT } from '../net/events';
import { codeFromUrl, useRoom } from '../net/useRoom';
import { FlipEditor } from './FlipEditor';
import { FlipView } from './Flip';
import { TopicForm } from './TopicForm';
import { splitTopic, widestOf } from './topicLines';
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
      // 最後に押した人はタップ音を鳴らさないので、ここを黙らせると1.2秒の無音になる
      case 'tally': play('tally'); break;
      case 'result': {
        const verdict = v.answer?.tally?.verdict;
        // 'none'（採点者が居なかった）は鳴らさない。知らせる出来事が無い
        if (verdict === 'perfect') play('perfect');
        else if (verdict === 'big') play('big');
        else if (verdict === 'medium') play('medium');
        else if (verdict === 'small') play('small');
        break;
      }
      // 判定が終わって板へ戻った合図。**intro からの open では鳴らさない**
      // （直前に strike が鳴っているので重なる）
      case 'open': if (was.phase === 'result') play('resume'); break;
      default: break;                      // stage は無音
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.roomPhase, v?.topicPhase, v?.topicId, v?.answer?.tally?.verdict]);
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

  // 場面が変わったら画面の頭へ戻す。前の場面のスクロール位置が残っていると、
  // 次の場面が画面の外から始まり「何も出ていない」ように見える（実際に見た）
  useEffect(() => { window.scrollTo({ top: 0 }); }, [v.topicPhase, v.topicId]);

  return (
    <div className="app">
      {v.topicPhase === 'intro' ? (
        /* 新しいお題は全画面で数秒。読み切ってからボードへ移る（SPEC.md §3.2） */
        <TopicPlate key={v.topicId ?? 'intro'} text={v.topic ?? ''} deadline={v.deadline} />
      ) : v.topicPhase === 'declared' ? (
        <div className="declare">
          <div>
            <b>{v.answer?.playerName} さんが回答します</b>
            <div className="rule" />
            <small>この あと 公開</small>
          </div>
        </div>
      ) : (
        <>
          {v.topic && <TopicStrip text={v.topic} />}

          {v.topicPhase === 'open' && (
            <>
              <FlipEditor flip={flip} onChange={setFlip} onActivity={(w) => r.setWriting(w)} />
              <div className="act">
                <button className="gold" disabled={empty || !!v.answer} onClick={() => r.claim(flip)}>
                  回答する
                </button>
              </div>
            </>
          )}

          {v.topicPhase === 'stage' && (
            <div className="wait">
              {iAnswer ? (
                <button className="gold" style={{ padding: '20px 56px', fontSize: 22, letterSpacing: '.14em' }} onClick={() => r.reveal()}>
                  公開する
                </button>
              ) : (
                <span>{v.answer?.playerName} さんが公開するのを待っています</span>
              )}
            </div>
          )}

          {v.topicPhase === 'reveal' && v.answer?.flip && (
            <>
              <FlipView flip={v.answer.flip} lift />
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

          {v.topicPhase === 'tally' && (
            <div className="tally">
              <div>
                <b>集計中</b>
                <div className="dots"><i /><i /><i /></div>
              </div>
            </div>
          )}

          {v.topicPhase === 'result' && v.answer && (
            /* 判定のときだけフリップを一回り小さくする。
               背の低いウィンドウで、板と判定が同時に画面へ入らないため */
            <div className="resulted">
              {v.answer.flip && <FlipView flip={v.answer.flip} />}
              <Verdict a={v.answer} />
            </div>
          )}
        </>
      )}

      {/* サーバーはもう次の画面に進んでいる。ここに残っているのは幕がめくれる 0.42 秒だけ */}
      {leavingIntro && <TopicPlate key="outro" text={v.topic ?? ''} deadline={null} out />}

      {canWrite && v.topicPhase !== 'open' && v.topicPhase !== 'declared' && (
        <details style={{ marginTop: 24 }}>
          <summary>次のネタを仕込む</summary>
          <div style={{ marginTop: 12 }}>
            <FlipEditor flip={flip} onChange={setFlip} onActivity={(w) => r.setWriting(w)} />
          </div>
        </details>
      )}

      <details style={{ marginTop: 18 }}>
        <summary>オリジナルのお題を追加する（{v.handmadeCount}問たまっています）</summary>
        <div className="card" style={{ marginTop: 12 }}>
          <TopicForm myTopics={v.myTopics} count={v.handmadeCount} post={r.postTopic} remove={r.removeTopic} />
        </div>
      </details>

      <div className="dock">
        <div className="inner">
          <div className="seats">
            {v.players.map((p) => (
              <span key={p.id} className="seat" data-off={p.connected ? 0 : 1} data-ready={p.ready ? 1 : 0}>
                {p.name}
                {p.perfects > 0 && <span className="p">満点 {p.perfects}</span>}
                {p.writing && <span className="w">書いています</span>}
              </span>
            ))}
          </div>
          <SoundToggle />
          {me?.isHost && <button onClick={() => r.toLobby()}>ロビーへ</button>}
          <button
            className={me?.ready ? '' : 'gold'}
            onClick={() => r.setReady(!me?.ready)}
          >
            {v.agree === 'reroll' ? 'お題を引き直す' : '次のお題に行く'}（{v.readyCount} / {v.aliveCount}人）
          </button>
        </div>
      </div>
    </div>
  );
}

function Verdict({ a }: { a: NonNullable<V['answer']> }) {
  const t = a.tally;
  if (!t) return null;
  const label = { small: '小笑い', medium: '中笑い', big: '大笑い', perfect: '満点大笑い', none: '判定なし' }[t.verdict];
  return (
    <div className={`verdict${t.verdict === 'perfect' ? ' perfect' : ''}`}>
      <b>{label}</b>
      {t.judges > 0 && (
        <p className="counts">小 {t.counts[1]}　中 {t.counts[2]}　大 {t.counts[3]}</p>
      )}
    </div>
  );
}
