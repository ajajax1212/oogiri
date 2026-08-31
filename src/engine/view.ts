import type { Flip, GalleryEntry, GameState, Tally, TopicPhase, RoomPhase, Verdict } from './types';

/**
 * 1人分に絞った状態（SPEC.md §8.4）。
 *
 * 全員に同じ状態を配らない。通信を覗かれても破綻しないことを基準に落とす。
 * ここに状態を足すときも同じ基準で判断する。
 */

export type PlayerView = {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  perfects: number;
  ready: boolean;
  /** 書いているかどうかの真偽値だけ。中身は配らない */
  writing: boolean;
};

export type AnswerView = {
  playerId: string;
  playerName: string;
  /** 未公開のあいだは回答者本人にだけ配る */
  flip: Flip | null;
  /** 何人が押したか。誰が何を押したかは配らない */
  scored: number;
  judges: number;
  /** 自分が押したか。押し直しを画面側で止めるのに要る */
  iScored: boolean;
  tally: Tally | null;
};

export type View = {
  code: string;
  roomPhase: RoomPhase;
  topicPhase: TopicPhase;
  me: string;
  players: PlayerView[];
  topic: string | null;
  /** お題が変わったことをクライアントが判定するための識別子。文は伏せても id は配ってよい */
  topicId: string | null;
  /** 合意ボタンのラベル。回答が1件でも公開されたかで変わる */
  agree: 'reroll' | 'next';
  readyCount: number;
  aliveCount: number;
  answer: AnswerView | null;
  deadline: number | null;
  /** ロビーで全員に見せる。誰が入れたかは出さない（SPEC.md §9.2） */
  brought: { id: string; word: string; mine: boolean }[];
  /** 投稿された手書きお題は本文を配らない。自分の分だけ、消せるように返す */
  myTopics: { id: string; text: string }[];
  gallery: GalleryEntry[];
  handmadeCount: number;
};

export function viewFor(s: GameState, code: string, me: string): View {
  const a = s.answer;
  const judges = s.players.filter((p) => p.connected && p.id !== a?.playerId).length;
  const revealed = s.topicPhase === 'reveal' || s.topicPhase === 'tally' || s.topicPhase === 'result';

  return {
    code,
    roomPhase: s.roomPhase,
    topicPhase: s.topicPhase,
    me,
    players: s.players.map((p) => ({
      id: p.id, name: p.name, isHost: p.isHost, connected: p.connected,
      perfects: p.perfects, ready: p.ready, writing: p.writing,
    })),
    // declared のあいだだけお題を出さない。回答者の名前に視線を集めるため。
    // intro（全画面のお題）では当然出す
    topic: s.topicPhase === 'declared' ? null : s.topic?.text ?? null,
    topicId: s.topic?.id ?? null,
    agree: s.revealedCount === 0 ? 'reroll' : 'next',
    readyCount: s.players.filter((p) => p.connected && p.ready).length,
    aliveCount: s.players.filter((p) => p.connected).length,
    answer: a
      ? {
          playerId: a.playerId,
          playerName: s.players.find((p) => p.id === a.playerId)?.name ?? '',
          // 公開前のフリップは本人にだけ。他人に配ると公開前に読める
          flip: revealed || a.playerId === me ? a.flip : null,
          scored: Object.keys(a.scores).length,
          judges,
          iScored: !!a.scores[me],
          tally: a.tally,
        }
      : null,
    deadline: s.deadline,
    brought: s.brought.map((b) => ({ id: b.id, word: b.word, mine: b.byId === me })),
    // 見返し用の控え。**全部が既に公開された情報**なので、そのまま全員へ配れる
    // （history と違い、次のお題を計算できる材料は入っていない）
    gallery: s.gallery,
    // 他人が出したお題の本文は配らない。出るまで知らないから面白い
    myTopics: s.handmade.filter((h) => h.byId === me).map((h) => ({ id: h.id, text: h.text })),
    handmadeCount: s.handmade.length,
    // history（型・骨格・語尾・素材の内訳）と乱数シードは丸ごと落とす。
    // 漏れると次のお題を計算できてしまう
  };
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  small: '小笑い',
  medium: '中笑い',
  big: '大笑い',
  perfect: '満点大笑い',
  none: '判定なし',
};
