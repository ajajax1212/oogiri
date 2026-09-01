import { tally } from './judge';
import {
  emptyFlip, flipIsEmpty,
  type Action, type Flip, type GameState, type Player, type Score, type TopicRecord,
} from './types';

/**
 * ルールの本体。ここだけで完結させる（サーバーに条件分岐を足さない）。
 *
 * お題の生成だけは外から渡す。reducer が乱数と素材ファイルを抱えると、
 * 同じ状態から同じ結果が出なくなってテストが書けない。
 */
export type Ctx = {
  now: number;
  /** 新しいお題を1つ返す。作れなければ null */
  nextTopic: () => TopicRecord | null;
  /** 引き直しで捨てたお題を、生成側に知らせる */
  burnTopic?: (rec: TopicRecord) => void;
};

/** 演出のための間（SPEC.md §8.3）。クライアント側のタイマーで進めてはいけない */
export const DELAY = {
  /** 新しいお題を全画面で見せる間。読み切ってからボードへ移る。
      3.2秒だと3行のお題を読み終える前に消えるので、5.2秒に伸ばした */
  intro: 5200,
  declared: 2000,
  tally: 1200,
  // 判定の音（笑い声）は3.6秒ある。判定が出るのは溜めの終わり（closing.ts）なので、
  // ここが短いと**音が鳴り終わる前に白紙のフリップへ切り替わる**。実測で
  // 余裕が 43ms しか無かったので 300ms 足した（2026-08-31）
  result: 4800,
  /** 回答者の切断から回答権を解放するまで。一瞬の回線の揺れで落とさないため */
  release: 5000,
} as const;

export function createGame(): GameState {
  return {
    roomPhase: 'lobby',
    players: [],
    topic: null,
    topicPhase: 'open',
    revealedCount: 0,
    answer: null,
    deadline: null,
    brought: [],
    handmade: [],
    history: [],
    gallery: [],
  };
}

const alive = (s: GameState) => s.players.filter((p) => p.connected);
const byId = (s: GameState, id: string) => s.players.find((p) => p.id === id);

/** 合意ボタンのラベル。回答が1件でも公開されたかで変わる（SPEC.md §7.1） */
export function agreeLabel(s: GameState): '引き直す' | '次へ' {
  return s.revealedCount === 0 ? '引き直す' : '次へ';
}

export function reduce(state: GameState, action: Action, ctx: Ctx): GameState {
  if (state.roomPhase !== 'live') return state;

  switch (action.type) {
    case 'ANSWER_CLAIM': {
      // 先着1人だけ通す（SPEC.md §5.1）
      if (state.topicPhase !== 'open' || state.answer) return state;
      const me = byId(state, action.playerId);
      if (!me || !me.connected) return state;
      if (flipIsEmpty(action.flip)) return state; // ボタンの無効化は通信を叩けば素通りする

      return {
        ...state,
        // 「次のお題に行く」の印は**外さない**。回答するたびに押し直すのは煩わしい、
        // というのが本人の判断（2026-08-31）。回答しながら次へ行く意思を
        // 持てるようにする。印を外すのは §7.3 のボタンの意味が変わる1回だけ
        players: state.players.map((p) =>
          p.id === action.playerId ? { ...p, writing: false } : p,
        ),
        answer: { playerId: action.playerId, flip: action.flip, scores: {}, tally: null },
        topicPhase: 'declared',
        deadline: ctx.now + DELAY.declared,
      };
    }

    case 'ANSWER_REVEAL': {
      if (state.topicPhase !== 'stage') return state;
      if (state.answer?.playerId !== action.playerId) return state;
      return {
        ...state,
        topicPhase: 'reveal',
        deadline: null,
        revealedCount: state.revealedCount + 1,
        // **最初の公開のときだけ**意思を取り直す（§7.3）。ここでボタンの文字が
        // 「引き直す」から「次のお題に行く」へ変わるので、前の意味で押した印を
        // そのまま次の意味に流用してはいけない。2人目以降の公開では意味が
        // 変わらないので、押した印はそのまま残す（回答のたびに押し直させない）
        players: state.revealedCount === 0
          ? state.players.map((p) => ({ ...p, ready: false }))
          : state.players,
      };
    }

    case 'SCORE': {
      if (state.topicPhase !== 'reveal' || !state.answer) return state;
      if (state.answer.playerId === action.playerId) return state; // 自分の回答は採点できない
      if (state.answer.scores[action.playerId]) return state;      // 1人1回。変更も取り消しもない
      const me = byId(state, action.playerId);
      if (!me || !me.connected) return state;

      const scores = { ...state.answer.scores, [action.playerId]: action.value };
      const next = { ...state, answer: { ...state.answer, scores } };
      return allJudgesDone(next) ? closeScoring(next, ctx) : next;
    }

    case 'NEXT_READY': {
      const next = {
        ...state,
        players: state.players.map((p) =>
          p.id === action.playerId ? { ...p, ready: action.ready } : p,
        ),
      };
      return maybeAdvance(next, ctx);
    }

    case 'WRITING':
      return {
        ...state,
        players: state.players.map((p) =>
          p.id === action.playerId ? { ...p, writing: action.writing } : p,
        ),
      };

    case 'RELEASE_CLAIM': {
      // 回答者が declared / stage で切れたまま戻らない。回答権を解放する
      if (state.topicPhase !== 'declared' && state.topicPhase !== 'stage') return state;
      return maybeAdvance(
        { ...state, answer: null, topicPhase: 'open', deadline: null },
        ctx,
      );
    }

    case 'TICK': {
      if (state.deadline === null || action.now < state.deadline) {
        // 採点中に誰かが切断すると、残り全員で条件が満たされることがある
        if (state.topicPhase === 'reveal' && allJudgesDone(state)) return closeScoring(state, ctx);
        return state;
      }
      if (state.topicPhase === 'intro') {
        return { ...state, topicPhase: 'open', deadline: null };
      }
      if (state.topicPhase === 'declared') {
        return { ...state, topicPhase: 'stage', deadline: null };
      }
      if (state.topicPhase === 'tally') {
        return { ...state, topicPhase: 'result', deadline: action.now + DELAY.result };
      }
      if (state.topicPhase === 'result') {
        const back: GameState = { ...state, topicPhase: 'open', answer: null, deadline: null };
        return maybeAdvance(back, ctx);
      }
      return state;
    }
  }
}

/** 回答者以外の接続中プレイヤーが全員押したか（SPEC.md §6.3） */
function allJudgesDone(s: GameState): boolean {
  if (!s.answer) return false;
  const judges = alive(s).filter((p) => p.id !== s.answer!.playerId);
  if (judges.length === 0) return true; // 採点者0人。判定なしで進む
  return judges.every((p) => s.answer!.scores[p.id]);
}

function closeScoring(s: GameState, ctx: Ctx): GameState {
  const a = s.answer!;
  // 押した後に切断した人の票は有効なまま残す。押した事実は取り消さない
  const t = tally(Object.values(a.scores) as Score[]);
  // 判定が出た時点で控える。**id は状態から決める**（乱数や時刻を使うと、
  // 同じ状態から同じ結果が出なくなってテストが書けない）
  const entry = {
    id: `${s.topic?.id ?? '-'}|${a.playerId}|${s.gallery.length}`,
    topicId: s.topic?.id ?? '-',
    topicText: s.topic?.text ?? '',
    playerId: a.playerId,
    playerName: byId(s, a.playerId)?.name ?? '',
    flip: a.flip,
    tally: t,
  };
  return {
    ...s,
    gallery: [...s.gallery, entry],
    answer: { ...a, tally: t },
    topicPhase: 'tally',
    deadline: ctx.now + DELAY.tally,
    players: s.players.map((p) =>
      p.id === a.playerId && t.verdict === 'perfect' ? { ...p, perfects: p.perfects + 1 } : p,
    ),
  };
}

/**
 * 全員が押していて、かつ open のときだけ次のお題へ進む（SPEC.md §7.2）。
 * 回答が進行中のときは、最後の1人が押しても進まない。出ている回答を途中で消さないため。
 */
function maybeAdvance(s: GameState, ctx: Ctx): GameState {
  if (s.topicPhase !== 'open') return s;
  const living = alive(s); // 切断中の人は人数から外す
  if (living.length === 0 || !living.every((p) => p.ready)) return s;

  // 回答が0件のまま全員が押したなら、それは引き直し（§7.1）
  if (s.revealedCount === 0 && s.history.length > 0) {
    const last = s.history[s.history.length - 1];
    last.discarded = true;
    ctx.burnTopic?.(last);
  }
  return startTopic(s, ctx);
}

export function startTopic(s: GameState, ctx: Ctx): GameState {
  const rec = ctx.nextTopic();
  return {
    ...s,
    topic: rec ? { id: rec.id, text: rec.text } : null,
    history: rec ? [...s.history, rec] : s.history,
    // 新しいお題はまず全画面で見せる。読む時間を作ってからボードへ移す
    topicPhase: 'intro',
    revealedCount: 0,
    answer: null,
    deadline: ctx.now + DELAY.intro,
    // 新しいお題に移ったら、印を解除しフリップを空にする（フリップは各自の端末が持つ）
    players: s.players.map((p) => ({ ...p, ready: false, writing: false })),
  };
}

// --- 部屋の出入り。ルールではなく席の話だが、players を触るのでここに置く ---

export function addPlayer(s: GameState, p: Player): GameState {
  return { ...s, players: [...s.players, p] };
}

/**
 * ホストを渡す。ホストが抜けても部屋が続くようにするため（2026-08-31）。
 *
 * **繋がっている人の中で、いちばん先に座った人**へ渡す。乱数で選ぶと、
 * 同じ状態から同じ結果が出なくなってテストが書けない。誰も繋がっていない
 * ときは動かさない（そのうち誰かが戻ってくる。部屋ごと消えるのは sweep の仕事）。
 */
export function handoffHost(s: GameState, leavingId: string): GameState {
  const host = s.players.find((p) => p.isHost);
  if (host && host.id !== leavingId) return s; // ホストは抜けていない
  const next = s.players.find((p) => p.id !== leavingId && p.connected);
  if (!next) return s;
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, isHost: p.id === next.id })),
  };
}

export function setConnected(s: GameState, id: string, connected: boolean): GameState {
  return {
    ...s,
    players: s.players.map((p) => (p.id === id ? { ...p, connected, writing: false } : p)),
  };
}

export function start(s: GameState, ctx: Ctx): GameState {
  if (s.roomPhase !== 'lobby') return s;
  // gallery は消さない。**その晩に出た回答は、ゲームを跨いでも見返せる**方がいい
  return startTopic({ ...s, roomPhase: 'live', history: [] }, ctx);
}

export function toLobby(s: GameState): GameState {
  return {
    ...s,
    roomPhase: 'lobby',
    topic: null,
    topicPhase: 'open',
    revealedCount: 0,
    answer: null,
    deadline: null,
    // 満点回数はリセットする。持ち寄り語は残す（SPEC.md §9.2）
    players: s.players.map((p) => ({ ...p, perfects: 0, ready: false, writing: false })),
  };
}

export const blankFlip = (): Flip => emptyFlip();
