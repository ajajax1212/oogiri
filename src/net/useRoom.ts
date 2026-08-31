import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Flip, Score } from '../engine/types';
import type { View } from '../engine/view';
import { EV } from './events';

/** 手が止まってから「書いています」を消すまで。線の切れ目で消えない長さ */
const WRITING_LINGER = 1600;

/**
 * 接続・再接続・状態受信。
 *
 * 席の合鍵は sessionStorage に置く。localStorage だと同じブラウザの2つ目のタブが
 * 先の席を奪う（複数タブで動作確認するので、これは実際に踏む）。
 */

type Seat = { code: string; playerId: string; token: string };

const SEAT_KEY = 'oogiri.seat';

const loadSeat = (): Seat | null => {
  try {
    const raw = sessionStorage.getItem(SEAT_KEY);
    return raw ? (JSON.parse(raw) as Seat) : null;
  } catch {
    return null;
  }
};
const saveSeat = (s: Seat | null) => {
  try {
    if (s) sessionStorage.setItem(SEAT_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SEAT_KEY);
  } catch { /* プライベートウィンドウでは黙って諦める */ }
};

/** URL から部屋コードを読む。部屋の URL がそのまま招待状 */
export const codeFromUrl = (): string | null => {
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : null;
};

type Ack = { ok: boolean; error?: string; code?: string; playerId?: string; token?: string };

export function useRoom() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const sock = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    sock.current = s;
    s.on('connect', () => {
      setConnected(true);
      const seat = loadSeat();
      const code = codeFromUrl();
      // リロード後は元の席へ戻る。URL の部屋と合鍵の部屋が食い違うときは戻らない
      if (seat && (!code || seat.code === code)) {
        s.emit(EV.rejoin, seat, (r: Ack) => {
          if (!r?.ok) saveSeat(null);
        });
      }
    });
    s.on('disconnect', () => setConnected(false));
    s.on(EV.state, (v: View) => setView(v));
    return () => { s.close(); };
  }, []);

  const call = useCallback(
    (ev: string, payload: unknown) =>
      new Promise<Ack>((resolve) => {
        sock.current?.emit(ev, payload, (r: Ack) => resolve(r ?? { ok: false }));
      }),
    [],
  );

  /** 失敗を黙って捨てない。理由が画面に出ないと、押しても何も起きないボタンになる */
  const callShow = useCallback(
    async (ev: string, payload: unknown) => {
      const r = await call(ev, payload);
      setError(r.ok ? null : r.error ?? '受け付けられませんでした');
      return r;
    },
    [call],
  );

  const enter = useCallback(
    async (kind: 'create' | 'join', name: string, code?: string) => {
      setError(null);
      const r = await call(kind === 'create' ? EV.create : EV.join, { name, code });
      if (!r.ok) { setError(r.error ?? '入れませんでした'); return false; }
      const seat = { code: r.code!, playerId: r.playerId!, token: r.token! };
      saveSeat(seat);
      history.replaceState(null, '', `/g/${seat.code}`);
      return true;
    },
    [call],
  );

  const act = useCallback(
    async (msg: Record<string, unknown>) => {
      const r = await call(EV.action, msg);
      if (!r.ok && r.error) setError(r.error);
      return r.ok;
    },
    [call],
  );

  /**
   * 「書いています」の点灯。**消すほうだけ遅らせる。**
   *
   * ペンは点を打つたびに pointerdown / pointerup を繰り返すので、素のまま流すと
   * ちょんちょん描いた回数だけ全員の画面で印が点滅する。人が見て意味があるのは
   * 「今まさに手を動かしているか」であって、1回の線の切れ目ではない。
   *
   * 点けるのは即座（反応が遅いと嘘に見える）、消すのは手が止まって
   * しばらく経ってから。同じ値を続けて送らないので、通信も減る。
   */
  const writingOn = useRef(false);
  const writingOff = useRef<number | null>(null);
  const setWriting = useCallback((writing: boolean) => {
    if (writingOff.current !== null) {
      window.clearTimeout(writingOff.current);
      writingOff.current = null;
    }
    if (writing) {
      if (writingOn.current) return;   // もう点いている。同じものを送らない
      writingOn.current = true;
      void act({ type: 'WRITING', writing: true });
      return;
    }
    if (!writingOn.current) return;
    writingOff.current = window.setTimeout(() => {
      writingOff.current = null;
      writingOn.current = false;
      void act({ type: 'WRITING', writing: false });
    }, WRITING_LINGER);
  }, [act]);

  return {
    view, error, connected, setError,
    enter,
    leave: async () => { await call(EV.leave, {}); saveSeat(null); location.href = '/'; },
    addWord: (word: string, cat: string) => callShow(EV.word, { word, cat }),
    removeWord: (id: string) => callShow(EV.word, { remove: id }),
    postTopic: (text: string) => callShow(EV.topic, { text }),
    removeTopic: (id: string) => callShow(EV.topic, { remove: id }),
    startGame: () => callShow(EV.start, {}),
    toLobby: () => callShow(EV.toLobby, {}),
    kick: (playerId: string) => callShow(EV.kick, { playerId }),
    claim: (flip: Flip) => act({ type: 'ANSWER_CLAIM', flip }),
    reveal: () => act({ type: 'ANSWER_REVEAL' }),
    score: (value: Score) => act({ type: 'SCORE', value }),
    setReady: (ready: boolean) => act({ type: 'NEXT_READY', ready }),
    setWriting,
  };
}
