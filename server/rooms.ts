import { randomUUID } from 'node:crypto';
import { createGame, DELAY, reduce, type Ctx } from '../src/engine/reducer';
import { mulberry32, TopicSource, type TopicData } from '../src/engine/topic';
import type { Action, GameState, TopicRecord } from '../src/engine/types';
import { logTopic } from './log';

/**
 * 部屋・席・token・時計だけを持つ。**ゲームのルールは知らない。**
 * ここに条件分岐を足して挙動を変えると、reducer のテストが通っても本番が違う動きをする。
 */

export type Room = {
  code: string;
  state: GameState;
  /** 席の合鍵。ID だけで席を渡すと p0 p1 は推測できる */
  tokens: Map<string, string>;
  source: TopicSource;
  timer: NodeJS.Timeout | null;
  /** 回答者の切断から回答権を解放するまでの猶予 */
  release: NodeJS.Timeout | null;
  lastTouched: number;
};

const rooms = new Map<string, Room>();

/** 紛らわしい文字（0/O, 1/I）を外す。口頭で伝えることがある */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

export function createRoom(data: TopicData): Room {
  const code = newCode();
  const seed = (Math.random() * 2 ** 31) | 0; // シードはサーバーだけが持つ
  const room: Room = {
    code,
    state: createGame(),
    tokens: new Map(),
    source: new TopicSource(data, mulberry32(seed)),
    timer: null,
    release: null,
    lastTouched: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

export const getRoom = (code: string): Room | undefined => rooms.get(code?.toUpperCase?.() ?? '');

export function ctxOf(room: Room): Ctx {
  const players = () => room.state.players.filter((p) => p.connected).length;
  return {
    now: Date.now(),
    nextTopic: () => {
      const rec = room.source.next(room.state.history, room.state.brought, room.state.handmade);
      // 出た数を数えないと、引き直しの「率」が出せない
      if (rec) logTopic('served', room.code, rec, players());
      return rec;
    },
    burnTopic: (rec: TopicRecord) => {
      logTopic('discarded', room.code, rec, players());
      room.source.burn(rec);
    },
  };
}

/** 席を1つ足す。座席番号 p0..pn は players の並びと対応させる（絶対に並べ替えない） */
export function seat(room: Room, name: string): { playerId: string; token: string } {
  const playerId = `p${room.state.players.length}`;
  const token = randomUUID();
  room.tokens.set(playerId, token);
  room.state = {
    ...room.state,
    players: [
      ...room.state.players,
      {
        id: playerId,
        name,
        isHost: room.state.players.length === 0,
        connected: true,
        perfects: 0,
        ready: false,
        writing: false,
      },
    ],
  };
  return { playerId, token };
}

export const checkToken = (room: Room, playerId: string, token: string): boolean =>
  !!token && room.tokens.get(playerId) === token;

/**
 * 時計はサーバーが持つ（SPEC.md §8.3）。
 * クライアント側のタイマーで進めると、そのブラウザが落ちた瞬間に全員の進行が止まる。
 */
export function schedule(room: Room, onChange: () => void): void {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const d = room.state.deadline;
  if (d === null) return;
  room.timer = setTimeout(() => {
    room.timer = null;
    apply(room, { type: 'TICK', now: Date.now() }, onChange);
  }, Math.max(0, d - Date.now()));
}

/** 回答者が declared / stage のまま戻らないとき、回答権を解放する */
export function scheduleRelease(room: Room, onChange: () => void): void {
  clearRelease(room);
  const a = room.state.answer;
  if (!a) return;
  const phase = room.state.topicPhase;
  if (phase !== 'declared' && phase !== 'stage') return;
  const p = room.state.players.find((x) => x.id === a.playerId);
  if (!p || p.connected) return;
  room.release = setTimeout(() => {
    room.release = null;
    apply(room, { type: 'RELEASE_CLAIM' }, onChange);
  }, DELAY.release);
}

export function clearRelease(room: Room): void {
  if (room.release) { clearTimeout(room.release); room.release = null; }
}

/** 行動を1つ通し、状態が変わったらタイマーを引き直して配る */
export function apply(room: Room, action: Action, onChange: () => void): void {
  const before = room.state;
  room.state = reduce(before, action, ctxOf(room));
  room.lastTouched = Date.now();
  if (room.state === before) return;
  schedule(room, onChange);
  scheduleRelease(room, onChange);
  onChange();
}

/** 誰も触っていない部屋を捨てる。状態はメモリにしか無い（落ちれば消えるのは許容） */
export function sweep(maxIdleMs = 6 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastTouched < maxIdleMs) continue;
    if (room.timer) clearTimeout(room.timer);
    if (room.release) clearTimeout(room.release);
    rooms.delete(code);
  }
}
