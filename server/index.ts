import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import { handoffHost, reduce, setConnected, start, toLobby, type Ctx } from '../src/engine/reducer';
import { viewFor, type View } from '../src/engine/view';
import type { Score } from '../src/engine/types';
import { checkFlip, checkTopicText, checkWord, cleanName, EV, LIMIT, type WritingPush } from '../src/net/events';
import { apply, checkToken, clearRelease, createRoom, ctxOf, getRoom, schedule, scheduleRelease, seat, sweep, type Room } from './rooms';
import { topicData } from './topicData';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// ページは1枚だけ。/ も /g/<code> も同じ SPA を返し、クライアントが URL から
// 部屋コードを読む。部屋の URL がそのまま招待状になる
const dist = path.join(__dirname, '..', 'dist');

/**
 * キャッシュの効かせ方を3つに分ける。
 *
 * `assets/` はファイル名にハッシュが入るので、中身が変われば URL も変わる。永久に持たせてよい。
 * **`index.html` と `sfx/` は URL が変わらないのに中身が変わる。**
 * 素のままだとブラウザが古いものを使い続け、デプロイしても直らない
 * （実際に「音を差し替えたのに本番で古い音が鳴る」で踏んだ）。
 * `no-cache` は「使うな」ではなく「毎回サーバーに聞け」なので、
 * 変わっていなければ 304 で終わる。音源が大きくても通信は増えない。
 */
app.use(express.static(dist, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    else if (/[/\\]assets[/\\]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get(['/', '/g/:code'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(dist, 'index.html'));
});

type SocketData = {
  code?: string;
  playerId?: string;
  /** この相手に最後に渡したフリップの鍵。同じ鍵なら二度送らない */
  sentFlip?: string | null;
};
const sd = (s: Socket) => s.data as SocketData;

/** 1人分に絞った状態を、部屋の全員にそれぞれ配る */
function broadcast(room: Room): void {
  for (const s of io.sockets.sockets.values()) {
    const d = sd(s);
    if (d.code !== room.code || !d.playerId) continue;
    s.emit(EV.state, thinFlip(viewFor(room.state, room.code, d.playerId), d));
  }
  pushGallery(room);
}

/**
 * 一度渡したフリップは、同じ相手に二度送らない。
 *
 * 公開されたフリップは reveal / tally / result のあいだ、配信のたびに丸ごと乗っていた。
 * 回答1つで8〜9回 × 人数ぶん同じ絵が飛ぶ。実測で手書き3000点なら6人で 1.85MB、
 * 上限まで描かれると 24MB。中身は変わらないので、鍵が同じなら落としてよい。
 * 受け手は鍵ごとに憶えていて、載っていなければ手元のものを使う（useRoom）。
 *
 * 繋ぎ直すと socket が変わって `sentFlip` も消えるので、そのときは必ずもう一度届く。
 */
function thinFlip(v: View, d: ReturnType<typeof sd>): View {
  const key = v.answer?.flipKey ?? null;
  if (key === null) { d.sentFlip = null; return v; }
  if (d.sentFlip === key) return { ...v, answer: { ...v.answer!, flip: null } };
  d.sentFlip = key;
  return v;
}

/**
 * 見返し用の控えは**増えたぶんだけ**送る。
 *
 * かつては state に相乗りさせていて、「書いています」が切り替わるたびに
 * その晩の全フリップが飛んでいた。次に「増えたときだけ配列まるごと」に直したが、
 * **これも駄目だった**。1件増えるたびに溜まった全部を送り直すので、
 * 回答数の2乗で増える。実測で、40回やって4回に1回手書きが混じると、
 * 判定のたびに1人あたり 359KB（6人で 2.1MB）が飛んでいた。
 * これが「全員・PCでも・文字の回答でも重い」の正体だった。
 *
 * なので追記だけを送る。`from` は「この塊が控えの何番目から始まるか」。
 * 席に着いた人へは from=0 で全部渡す（受け手はそこから作り直す）。
 */
function pushGallery(room: Room): void {
  const n = room.state.gallery.length;
  if (n === room.sentGallery) return;
  const from = room.sentGallery;
  room.sentGallery = n;
  io.to(room.code).emit(EV.gallery, { from, entries: room.state.gallery.slice(from) });
}

const push = (room: Room) => () => broadcast(room);

function attach(socket: Socket, room: Room, playerId: string): void {
  sd(socket).code = room.code;
  sd(socket).playerId = playerId;
  socket.join(room.code);
  room.state = setConnected(room.state, playerId, true);
  clearRelease(room);
  schedule(room, push(room));
  broadcast(room);
  // 入ってきた本人にはその時点の控えを1回だけ全部渡す。以降は追記しか来ないので、
  // これが無いと途中から入った人や戻ってきた人の見返しが空のままになる
  socket.emit(EV.gallery, { from: 0, entries: room.state.gallery });
}

io.on('connection', (socket) => {
  socket.on(EV.create, ({ name }: { name?: string }, ack?: (r: unknown) => void) => {
    const n = cleanName(name);
    if (!n) return ack?.({ ok: false, error: '名前を入力してください' });
    const room = createRoom(topicData);
    const { playerId, token } = seat(room, n);
    attach(socket, room, playerId);
    ack?.({ ok: true, code: room.code, playerId, token });
  });

  socket.on(EV.join, ({ code, name }: { code?: string; name?: string }, ack?: (r: unknown) => void) => {
    const room = getRoom(String(code ?? ''));
    if (!room) return ack?.({ ok: false, error: 'その部屋は見つかりません' });
    if (room.state.roomPhase !== 'lobby') return ack?.({ ok: false, error: 'もう始まっています' });
    if (room.state.players.length >= 10) return ack?.({ ok: false, error: '満席です' });
    const n = cleanName(name);
    if (!n) return ack?.({ ok: false, error: '名前を入力してください' });
    const { playerId, token } = seat(room, n);
    attach(socket, room, playerId);
    ack?.({ ok: true, code: room.code, playerId, token });
  });

  socket.on(
    EV.rejoin,
    ({ code, playerId, token }: { code?: string; playerId?: string; token?: string }, ack?: (r: unknown) => void) => {
      const room = getRoom(String(code ?? ''));
      if (!room) return ack?.({ ok: false, error: 'その部屋は見つかりません' });
      // 席の合鍵で本人確認する。ID だけで席を渡すと p0 p1 は推測できるので、
      // 他人の手札ごと乗っ取れてしまう
      if (!playerId || !token || !checkToken(room, playerId, token)) {
        return ack?.({ ok: false, error: '席が確認できません' });
      }
      attach(socket, room, playerId);
      ack?.({ ok: true, code: room.code, playerId, token });
    },
  );

  socket.on(EV.word, (msg: { word?: string; cat?: string; remove?: string }, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;
    if (room.state.roomPhase !== 'lobby') return ack?.({ ok: false, error: 'ロビーにいる間だけです' });

    if (msg.remove) {
      const w = room.state.brought.find((b) => b.id === msg.remove);
      const host = room.state.players.find((p) => p.id === me)?.isHost;
      if (!w || (w.byId !== me && !host)) return ack?.({ ok: false, error: '消せません' });
      room.state = { ...room.state, brought: room.state.brought.filter((b) => b.id !== msg.remove) };
      broadcast(room);
      return ack?.({ ok: true });
    }

    const w = checkWord(msg.word, msg.cat);
    if (!w) return ack?.({ ok: false, error: `1〜${LIMIT.wordLen}文字で、種類を選んでください` });
    if (room.state.brought.filter((b) => b.byId === me).length >= LIMIT.wordsPerPlayer) {
      return ack?.({ ok: false, error: `1人${LIMIT.wordsPerPlayer}語までです` });
    }
    // 同じ部屋に同じ語は1つだけ（先勝ち）
    if (room.state.brought.some((b) => b.word === w.word)) {
      return ack?.({ ok: false, error: 'もう誰かが入れています' });
    }
    room.state = {
      ...room.state,
      brought: [...room.state.brought, { id: randomUUID().slice(0, 8), ...w, byId: me }],
    };
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on(EV.topic, (msg: { text?: string; remove?: string }, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;

    if (msg.remove) {
      const h = room.state.handmade.find((x) => x.id === msg.remove);
      if (!h || h.byId !== me) return ack?.({ ok: false, error: '消せるのは自分が出したお題だけです' });
      // まだ出ていないお題だけ消せる。出たあとに消しても意味がない
      room.state = { ...room.state, handmade: room.state.handmade.filter((x) => x.id !== msg.remove) };
      broadcast(room);
      return ack?.({ ok: true });
    }

    // 投稿はロビーでもゲーム中でもできる。お題を思いつくのは遊んでいる最中だから
    const text = checkTopicText(msg.text);
    if (!text) {
      return ack?.({ ok: false, error: `${LIMIT.topicMin}〜${LIMIT.topicMax}文字で書いてください` });
    }
    if (room.state.handmade.filter((h) => h.byId === me).length >= LIMIT.topicsPerPlayer) {
      return ack?.({ ok: false, error: `1人${LIMIT.topicsPerPlayer}問までです` });
    }
    if (room.state.handmade.some((h) => h.text === text)) {
      return ack?.({ ok: false, error: '同じお題がもう出ています' });
    }
    room.state = {
      ...room.state,
      handmade: [...room.state.handmade, { id: randomUUID().slice(0, 8), text, byId: me }],
    };
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on(EV.start, (_m: unknown, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;
    if (!room.state.players.find((p) => p.id === me)?.isHost) {
      return ack?.({ ok: false, error: 'ホストのみ操作できます' });
    }
    if (room.state.players.length < 2) return ack?.({ ok: false, error: '2人以上で始めます' });
    // **言葉は必須にしない**（2026-08-31 に本人が変更）。1語考えつかない人が
    // 出るたびに全員が待たされ、そこで場が止まっていた。0語でもお題は作れる
    // （持ち寄り語は素材に混ざるだけで、無ければ既定の素材から出る）
    const c: Ctx = ctxOf(room);
    room.state = start(room.state, c);
    schedule(room, push(room));
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on(EV.toLobby, (_m: unknown, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;
    if (!room.state.players.find((p) => p.id === me)?.isHost) {
      return ack?.({ ok: false, error: 'ホストのみ操作できます' });
    }
    room.state = toLobby(room.state);
    schedule(room, push(room));
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on(EV.kick, ({ playerId }: { playerId?: string }, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;
    if (!room.state.players.find((p) => p.id === me)?.isHost) return;
    // 追い出しの道具ではなく、落ちた人が席を占めたまま始められなくなるのを解くためのもの。
    // ゲーム中に外すと players の並びが p0..pn とずれて盤面ごと壊れる
    if (room.state.roomPhase !== 'lobby') return ack?.({ ok: false, error: 'ロビーにいる間だけです' });
    const t = room.state.players.find((p) => p.id === playerId);
    if (!t || t.connected) return ack?.({ ok: false, error: '切れている人だけ外せます' });
    room.state = {
      ...room.state,
      players: room.state.players.filter((p) => p.id !== playerId),
      brought: room.state.brought.filter((b) => b.byId !== playerId),
    };
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on(EV.action, (msg: { type?: string; flip?: unknown; value?: unknown; ready?: unknown; writing?: unknown }, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;
    const on = push(room);

    switch (msg.type) {
      case 'ANSWER_CLAIM': {
        const flip = checkFlip(msg.flip);
        if (!flip) return ack?.({ ok: false, error: 'フリップを受け取れませんでした' });
        if (room.state.answer) return ack?.({ ok: false, error: '今は他の人が回答しています' });
        apply(room, { type: 'ANSWER_CLAIM', playerId: me, flip }, on);
        // 先着1人だけが通る。通ったかどうかは本人にも返す
        const holder = room.state.answer as { playerId: string } | null;
        return ack?.({ ok: holder?.playerId === me });
      }
      case 'ANSWER_REVEAL':
        apply(room, { type: 'ANSWER_REVEAL', playerId: me }, on);
        return ack?.({ ok: true });
      case 'SCORE': {
        if (![1, 2, 3].includes(msg.value as number)) return ack?.({ ok: false });
        apply(room, { type: 'SCORE', playerId: me, value: msg.value as Score }, on);
        return ack?.({ ok: true });
      }
      case 'NEXT_READY':
        apply(room, { type: 'NEXT_READY', playerId: me, ready: !!msg.ready }, on);
        return ack?.({ ok: true });
      case 'WRITING': {
        // **これだけは state を配らない。** 6人いると常に誰かが書き始めたり
        // 止めたりしていて、実測で毎秒3.8回、全員の画面が丸ごと作り直されていた。
        // 伝えたいのは真偽値1つなので、それだけ配って画面側で差し替えてもらう。
        // 状態はサーバーが持ったままなので、次の配信でも辻褄は合う
        const before = room.state;
        room.state = reduce(before, { type: 'WRITING', playerId: me, writing: !!msg.writing }, ctxOf(room));
        // apply() を通さないので、部屋が使われている印は自分で押す。
        // 押さないと「書いているだけの部屋」が放置扱いで掃除される
        room.lastTouched = Date.now();
        if (room.state !== before) {
          const push: WritingPush = { playerId: me, writing: !!msg.writing };
          io.to(room.code).emit(EV.writing, push);
        }
        return ack?.({ ok: true });
      }
      default:
        return ack?.({ ok: false });
    }
  });

  // ack を必ず返す。クライアントは `await` してから席を捨てて画面を移すので、
  // 返さないと**抜けた本人の画面だけが部屋に貼り付いたまま**になる
  socket.on(EV.leave, (_m: unknown, ack?: (r: unknown) => void) => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return ack?.({ ok: true });

    // 抜ける人が回答権を持ったまま消えると、誰も公開できず場が止まる。
    // 先に回答権を返してから席を外す（切断と同じ扱い）
    if (room.state.answer?.playerId === me) {
      apply(room, { type: 'RELEASE_CLAIM' }, push(room));
    }

    room.state = {
      ...room.state,
      players: room.state.players.filter((p) => p.id !== me),
      brought: room.state.brought.filter((b) => b.byId !== me),
    };
    // **ホストが抜けても部屋は続ける。**次に座っている人へ渡す（2026-08-31）。
    // 渡さないと「始める」を押せる人が居なくなって、全員が作り直す羽目になる
    room.state = handoffHost(room.state, me);
    room.tokens.delete(me);
    sd(socket).code = undefined;
    sd(socket).playerId = undefined;

    // 抜けたことで採点や合意の条件が満たされることがある（残り全員が押し終える）
    apply(room, { type: 'TICK', now: Date.now() }, push(room));
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const { room, me } = ctxSocket(socket);
    if (!room || !me) return;
    room.state = setConnected(room.state, me, false);
    // 落ちた人がホストだと「始める」が押せなくなるので、繋がっている人へ渡す。
    // 席は残すので、戻ってきてもゲームは続けられる（ホストは戻らない）
    room.state = handoffHost(room.state, me);
    // 誰かが抜けたことで採点や合意の条件が満たされることがあるので、TICK を1つ打つ
    apply(room, { type: 'TICK', now: Date.now() }, push(room));
    scheduleRelease(room, push(room));
    broadcast(room);
  });
});

function ctxSocket(socket: Socket): { room?: Room; me?: string } {
  const d = sd(socket);
  if (!d.code || !d.playerId) return {};
  const room = getRoom(d.code);
  if (!room) return {};
  return { room, me: d.playerId };
}

setInterval(() => sweep(), 30 * 60 * 1000);

const port = Number(process.env.PORT ?? 3600);
httpServer.listen(port, () => console.log(`大喜利 http://localhost:${port}`));

