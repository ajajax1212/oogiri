/**
 * 効果音（SPEC.md §10.3）。
 *
 * **音源ファイルを鳴らし、読めなければ合成音に落ちる。** 作りは
 * senryu-game/src/ui/sound.ts に合わせてある（`SFX` の表と `MASTER` で音量を決める）。
 * 音のライブラリは入れない。読み書きは Web Audio を直接叩く。
 *
 * **合成音（tone / noise / taiko / metal / bell と `synth`）は消さないこと。**
 * 取得に失敗してもオフラインでも鳴らすための保険。senryu で同じ作りにしてある。
 *
 * 音源の出どころは本人が用意した `sound/`（追跡外）。配るのは `public/sfx/` の方だけ。
 *
 * **既定はオフ。** 通話しながら遊ぶことが多いので、黙って鳴り出すほうが害が大きい。
 * 明示的に入れた人にだけ鳴らす。オフの人には AudioContext すら作らない。
 *
 * **AudioContext はユーザー操作の中でしか作らない。** ブラウザは操作の無い
 * ページの音を止めるので、トグルを押した瞬間が唯一の確実な機会になる。
 */

const KEY = 'oogiri.sfx';

export type SfxName =
  /** 新しいお題の全画面。一撃。ここが一番の見せ場 */
  | 'strike'
  /** 「〇〇さんが回答します」。誰かが回答権を取ったことを全員に知らせる */
  | 'declare'
  /** フリップが掲げられる。お題発表と同じ音を少しだけ下げて使う */
  | 'lift'
  /** 採点ボタン。軽いタップ */
  | 'tap'
  /** 判定：小笑い */
  | 'small'
  /** 判定：中笑い */
  | 'medium'
  /** 判定：大笑い */
  | 'big'
  /** 判定：満点大笑い。ここだけ別格 */
  | 'perfect'
  /** 集計中。ここを黙らせると、最後に押した人だけ1.2秒の無音になる */
  | 'tally'
  /** 判定が終わって板へ戻る。「次を書ける」の合図 */
  | 'resume';

/**
 * 音ごとの大きさと長さ。
 *
 * `stack` は、その音の recipe に書いた係数の合計。全部の声が同時に頂点へ来た
 * ときの最悪値で、senryu の「実測ピーク」に当たる。あちらは mp3 を decode して
 * 測ったが、こちらは声を自分で書いているので合計が分かる。
 *
 * `peak` が狙いのピーク。**音どうしの大小はこの数字だけで比べられる**ので、
 * 「判定より宣言が大きい」のような崩れは表を見れば分かる。
 * 実際に各声へ渡す係数は `係数 × (peak / stack)`。
 *
 * `dur` は鳴り終わるまでの秒数。次の場面と被らないかを机上で確かめるために書く
 * （intro 5.2秒 / declared 2.0秒 / tally 1.2秒 / result 4.5秒。engine 側の DELAY）。
 */
type SfxSpec = {
  stack: number;
  peak: number;
  dur: number;
};

const SFX: Record<SfxName, SfxSpec> = {
  // 一番大きい音。これを基準に他を決めた
  strike: { stack: 1.2, peak: 0.30, dur: 1.30 },
  declare: { stack: 1.0, peak: 0.20, dur: 0.70 },
  lift: { stack: 1.0, peak: 0.22, dur: 1.73 },
  // 連打されるボタンなので、他より一桁近く小さく
  tap: { stack: 1.0, peak: 0.07, dur: 0.09 },
  // 小 → 中 → 大 は「打数・低さ・音量」の3つを同時に増やす。
  // 音量だけで差を付けると、音量を絞って聞いている人に差が伝わらない
  // 4つとも実測から入れ直したうえで、さらに体感 -30%（振幅 ×0.554）。
  // 判定は1問に1度必ず鳴り、しかも笑い声なので、他の音と同じ大きさだと疲れる
  small: { stack: 1.0, peak: 0.072, dur: 0.35 },
  medium: { stack: 1.0, peak: 0.100, dur: 0.62 },
  big: { stack: 1.0, peak: 0.133, dur: 0.95 },
  // 別格。大きさより「構成」で格を出す（ロール → 大一撃 → 金の4音）
  perfect: { stack: 1.0, peak: 0.177, dur: 2.10 },
  tally: { stack: 1.0, peak: 0.14, dur: 1.20 },
  // 戻ってきた合図。次の一手を促すだけなので、判定より小さく短く
  resume: { stack: 1.0, peak: 0.11, dur: 0.45 },
};

/**
 * 音源ファイル。**ページを開いただけでは取りに行かない。**
 * 音を入れた人の操作を待ってから読む（SPEC.md §10.3）。
 *
 * 素材ごとに素のピークがばらつくので、`gain` は「`SFX` の `peak` ÷ 実測ピーク」。
 * 同じ数字を全部に掛けると音量が揃わない。ここに無い音は合成音で鳴る。
 *
 * **実測ピークは decode して測った値**（括弧内）。目分量で決めると、
 * 判定の4つのように素材が揃って大きいときに、そこだけ殴られる感じになる。
 * この式で入れておくと、音源が読めずに合成音へ落ちても大きさが変わらない。
 * 測り直すときは decodeAudioData して全チャンネルの平均の絶対値の最大を取る。
 */
const FILES: Partial<Record<SfxName, { url: string; gain: number }>> = {
  strike: { url: '/sfx/strike.mp3', gain: 0.90 },   // お題発表.mp3（実測 0.28）
  // 「回答するボタン.mp3」。回答権を取ったことを全員に知らせる合図なので、
  // 押した本人だけでなく全画面で鳴る（declared への切り替わりで1回）
  declare: { url: '/sfx/declare.mp3', gain: 0.63 }, // 回答するボタン.mp3（実測 0.32）
  // **公開はお題発表と同じ音**（中身は同じ mp3 を置いてある）。
  // まったく同じ大きさだと2つの場面が混ざるので、こちらだけ少し下げる
  lift: { url: '/sfx/lift.mp3', gain: 0.78 },       // お題発表.mp3（実測 0.28）
  tally: { url: '/sfx/tally.mp3', gain: 0.50 },     // 集計中.mp3（実測 0.43）
  // 判定の4つだけ素材が飛び抜けて大きい（実測 0.76〜0.95。他は 0.28〜0.43）。
  // 実測から入れ直したうえで、さらに体感 -30% 落としてある。
  // 中が大より大きいという逆転もここで直る（素材は medium がいちばん大きい）
  small: { url: '/sfx/small.wav', gain: 0.094 },    // 小笑い.wav（実測 0.76）
  medium: { url: '/sfx/medium.wav', gain: 0.111 },  // 中笑い.wav（実測 0.89）
  big: { url: '/sfx/big.wav', gain: 0.172 },        // 大笑い.wav（実測 0.77）
  perfect: { url: '/sfx/perfect.wav', gain: 0.188 },// 満点大笑い.wav（実測 0.95）
};

const buffers = new Map<SfxName, AudioBuffer>();
let loading = false;

/**
 * 全体の音量。上げ下げしたいときはまずこの数字だけ動かす。
 * 合成音は生音源より密度が薄く、同じピークでも小さく聞こえるので、
 * senryu（0.75）より少しだけ上げてある。
 */
const MASTER = 0.85;

let enabled = readStored();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    // プライベートモード等で localStorage が触れないことがある。音は無くても遊べる
    return false;
  }
}

export function sfxEnabled(): boolean {
  return enabled;
}

export function setSfxEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* 保存できなくてもこの回だけは効かせる */
  }
  // 入れた合図に1音鳴らす。無音のままだと音量が適正か分からない。
  // 判定のいちばん軽い音を使う（短くて、この後よく聞くことになる音）
  if (on) { void load(); play('small'); }
  for (const fn of listeners) fn();
}

export function subscribeSfx(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * AudioContext は最初に鳴らすときまで作らない。
 * ページを開いただけで作ると、音を出さない人のためにブラウザが suspended の
 * まま資源を抱えることになる。
 */
function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 音量調整を一か所に通すため、どの声も必ずここへ挿す */
function out(ac: AudioContext): AudioNode {
  return master ?? ac.destination;
}

/* --------------------------------------------------------------- 声の部品 */

/** 単発の音。波形と周波数の滑り、長さ、音量だけで作る */
function tone(
  ac: AudioContext,
  opt: { type: OscillatorType; from: number; to?: number; dur: number; gain: number; at?: number },
): void {
  const t0 = ac.currentTime + (opt.at ?? 0);
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = opt.type;
  osc.frequency.setValueAtTime(opt.from, t0);
  if (opt.to !== undefined) osc.frequency.exponentialRampToValueAtTime(opt.to, t0 + opt.dur);
  // 立ち上がりを0にすると「プツッ」と鳴るので、2msだけ持ち上げてから落とす
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, opt.gain), t0 + 0.002);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
  osc.connect(amp).connect(out(ac));
  osc.start(t0);
  osc.stop(t0 + opt.dur + 0.02);
}

/** 皮の当たりや空気の擦れ。正弦波では作れないのでホワイトノイズを帯域で削る */
function noise(
  ac: AudioContext,
  opt: {
    dur: number;
    freq: number;
    /** 与えると帯域の中心を滑らせる。持ち上がる「スウッ」を作るのに要る */
    to?: number;
    q: number;
    gain: number;
    at?: number;
    type?: BiquadFilterType;
  },
): void {
  const t0 = ac.currentTime + (opt.at ?? 0);
  const frames = Math.max(1, Math.floor(ac.sampleRate * opt.dur));
  const buf = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = opt.type ?? 'bandpass';
  bp.frequency.setValueAtTime(opt.freq, t0);
  if (opt.to !== undefined) bp.frequency.exponentialRampToValueAtTime(opt.to, t0 + opt.dur);
  bp.Q.value = opt.q;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(opt.gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
  src.connect(bp).connect(amp).connect(out(ac));
  src.start(t0);
}

/**
 * 太鼓の一打。胴の鳴り・倍音・皮の当たりを重ねる。
 * 周波数を急に落とす正弦が胴、三角波の倍音が「ボッ」を「ドッ」に変える。
 */
function taiko(
  ac: AudioContext,
  opt: { at: number; gain: number; from: number; to: number; dur: number },
): void {
  tone(ac, { type: 'sine', from: opt.from, to: opt.to, dur: opt.dur, gain: opt.gain, at: opt.at });
  tone(ac, {
    type: 'triangle',
    from: opt.from * 2,
    to: opt.to * 2,
    dur: opt.dur * 0.35,
    gain: opt.gain * 0.3,
    at: opt.at,
  });
  noise(ac, { dur: 0.06, freq: 300, q: 0.5, gain: opt.gain * 0.5, at: opt.at });
}

/**
 * 金物（ゴング・シンバルの類）。
 *
 * 倍音を整数比で積むと楽器の音になってしまい「カン」と鳴らない。
 * 非整数比で積むと途端に金物になる。高い成分ほど早く落とす。
 */
const METAL_RATIOS = [1, 1.73, 2.41, 3.14, 4.07];

function metal(ac: AudioContext, opt: { at: number; gain: number; dur: number; base: number }): void {
  METAL_RATIOS.forEach((r, i) => {
    tone(ac, {
      type: i === 0 ? 'triangle' : 'sine',
      from: opt.base * r,
      dur: opt.dur * (1 - i * 0.14),
      gain: opt.gain * 0.5 ** i,
      at: opt.at,
    });
  });
  // 当たりの「チッ」。これが無いと金物ではなく笛に聞こえる
  noise(ac, { dur: 0.04, freq: 6000, q: 0.8, gain: opt.gain * 0.6, at: opt.at, type: 'highpass' });
}

/** 鐘。基音と 2.76 倍の唸りで、金属の澄んだ余韻を作る */
function bell(ac: AudioContext, opt: { at: number; gain: number; dur: number; freq: number }): void {
  tone(ac, { type: 'sine', from: opt.freq, dur: opt.dur, gain: opt.gain, at: opt.at });
  tone(ac, { type: 'sine', from: opt.freq * 2.76, dur: opt.dur * 0.55, gain: opt.gain * 0.32, at: opt.at });
}

/* ------------------------------------------------------------------ 鳴らす */

/**
 * 音源をまとめて読む。入れた瞬間に呼ぶので、最初の1音だけ合成音になることがある。
 * **読み込み中に合成音へ落とすのは意図的**（無音より、鳴り方が違う方がまし）。
 */
async function load(): Promise<void> {
  const ac = audio();
  if (!ac || loading) return;
  loading = true;
  await Promise.all(
    (Object.keys(FILES) as SfxName[]).map(async (name) => {
      if (buffers.has(name)) return;
      try {
        const res = await fetch(FILES[name]!.url);
        if (!res.ok) return; // 落ちても合成音で鳴る
        buffers.set(name, await ac.decodeAudioData(await res.arrayBuffer()));
      } catch {
        /* オフラインでも遊べるように、黙って合成音へ落とす */
      }
    }),
  );
  // 取り損ねた音は次の機会に取り直す。1回失敗しただけで合成音に固定されると、
  // 一瞬の回線の揺れがその場に居る間ずっと響く
  loading = false;
}

export function play(name: SfxName): void {
  const ac = audio();
  if (!ac) return;
  const buf = buffers.get(name);
  if (buf) {
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = FILES[name]!.gain;
    src.connect(g).connect(out(ac));
    src.start();
    return;
  }
  synth(ac, name, SFX[name].peak / SFX[name].stack);
}

/**
 * 音の中身。`g` は「狙いのピーク ÷ 声の合計」で、各声の係数に掛ける。
 * 係数の合計が SFX の `stack` と釣り合っている限り、表の `peak` が実際の頂点になる。
 */
function synth(ac: AudioContext, name: SfxName, g: number): void {
  switch (name) {
    case 'strike':
      // 見せ場の一撃。胴の一打 + 長い低音の尻 + 金物の艶。
      // 「もったいぶって一撃で決める」呼吸に合わせ、余韻だけを長く残す
      taiko(ac, { at: 0, gain: 0.55 * g, from: 190, to: 46, dur: 0.55 });
      tone(ac, { type: 'sine', from: 70, to: 32, dur: 1.15, gain: 0.22 * g });
      metal(ac, { at: 0.005, gain: 0.15 * g, dur: 1.2, base: 520 });
      noise(ac, { dur: 0.05, freq: 240, q: 0.5, gain: 0.28 * g });
      break;

    case 'declare':
      // 宣言。一打だけ。名前を読むための静けさを潰さないよう、金物は細く短く
      taiko(ac, { at: 0, gain: 0.6 * g, from: 150, to: 44, dur: 0.38 });
      tone(ac, { type: 'sine', from: 62, to: 30, dur: 0.55, gain: 0.22 * g });
      metal(ac, { at: 0.01, gain: 0.18 * g, dur: 0.42, base: 820 });
      break;

    case 'lift':
      // 板が持ち上がって止まる。帯域を上へ滑らせた息 + 支える正弦、
      // 0.3秒で軽い着地。画面の lift アニメ（0.55秒）と頭を揃えてある
      noise(ac, { dur: 0.32, freq: 300, to: 2600, q: 0.8, gain: 0.5 * g });
      tone(ac, { type: 'sine', from: 220, to: 640, dur: 0.3, gain: 0.2 * g });
      taiko(ac, { at: 0.3, gain: 0.3 * g, from: 240, to: 92, dur: 0.16 });
      break;

    case 'tap':
      // 指先の返事。長いと連打で濁るので 45ms で切る
      tone(ac, { type: 'square', from: 900, to: 420, dur: 0.045, gain: 0.55 * g });
      noise(ac, { dur: 0.035, freq: 3000, q: 1.2, gain: 0.45 * g });
      break;

    case 'tally':
      // 集計中。1.2秒の谷を埋めるだけなので、主張しない低い心音を2つ
      taiko(ac, { at: 0, gain: 0.5 * g, from: 120, to: 58, dur: 0.16 });
      taiko(ac, { at: 0.42, gain: 0.4 * g, from: 116, to: 56, dur: 0.16 });
      break;

    case 'resume':
      // 板が戻る。lift を裏返した形（息を下げ、二音で上がって終わる）。
      // 判定の余韻の直後に鳴るので、太鼓は使わず息と細い二音だけにする
      noise(ac, { dur: 0.22, freq: 2200, to: 420, q: 0.8, gain: 0.42 * g });
      bell(ac, { at: 0.06, gain: 0.30 * g, dur: 0.30, freq: 587.33 });
      bell(ac, { at: 0.17, gain: 0.28 * g, dur: 0.36, freq: 880 });
      break;

    case 'small':
      // 一打だけ、高めで短い
      taiko(ac, { at: 0, gain: 1.0 * g, from: 210, to: 72, dur: 0.3 });
      break;

    case 'medium':
      // 二つ打ち。二打目を少し低く強くすると「ドドン」と締まる
      taiko(ac, { at: 0, gain: 0.45 * g, from: 190, to: 64, dur: 0.22 });
      taiko(ac, { at: 0.16, gain: 0.55 * g, from: 165, to: 52, dur: 0.42 });
      break;

    case 'big':
      // 三連から低い締めへ。最後の一打にだけ金物を重ねて頭ひとつ出す
      taiko(ac, { at: 0, gain: 0.22 * g, from: 200, to: 74, dur: 0.16 });
      taiko(ac, { at: 0.11, gain: 0.26 * g, from: 185, to: 66, dur: 0.16 });
      taiko(ac, { at: 0.22, gain: 0.34 * g, from: 160, to: 46, dur: 0.55 });
      metal(ac, { at: 0.22, gain: 0.18 * g, dur: 0.7, base: 620 });
      break;

    case 'perfect': {
      // 別格。ロールで溜めて、大一撃、そこへ金の4音を重ねる。
      // 音量ではなく「段取り」で格を付ける。大きさで殴ると耳が痛いだけになる
      const ROLL = 6;
      for (let i = 0; i < ROLL; i++) {
        // 間隔を詰めながら強くしていく。等間隔だと機械の音に聞こえる
        const at = 0.42 * (i / ROLL) ** 1.6;
        taiko(ac, {
          at,
          gain: (0.24 / ROLL) * (0.6 + (0.8 * i) / ROLL) * g,
          from: 230,
          to: 110,
          dur: 0.09,
        });
      }
      taiko(ac, { at: 0.46, gain: 0.3 * g, from: 200, to: 42, dur: 0.8 });
      tone(ac, { type: 'sine', from: 66, to: 30, dur: 1.4, gain: 0.12 * g, at: 0.46 });
      metal(ac, { at: 0.46, gain: 0.12 * g, dur: 1.5, base: 560 });
      // 金の4音。素直な陽音階で上がる（都節にすると弔いの気配が出る）
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        bell(ac, { at: 0.6 + i * 0.12, gain: 0.055 * g, dur: 0.9 - i * 0.1, freq: f });
      });
      break;
    }
  }
}

/**
 * 前回オンにしていた人のための用意。
 *
 * 合成音なので取りに行くファイルは無い。用意が要るのは AudioContext のほうで、
 * これは操作の中でしか確実に起こせない。**最初の操作**（どこかを押した瞬間）に
 * 一度だけ起こしておくと、そのあと場面が変わって鳴る音が最初から間に合う。
 * オフの人は何も登録しないので、「開いただけで何も起きない」は保たれている。
 */
if (enabled && typeof window !== 'undefined') {
  // **音源の取得もここで始める。** 以前は audio() だけ呼んでいたので、
  // 前回オンにしたまま再読込した人には fetch が一度も走らず、
  // 差し替えた音源が永久に鳴らずに合成音のままだった（「音が反映されない」の正体）
  const prime = () => { audio(); void load(); };
  window.addEventListener('pointerdown', prime, { once: true, capture: true });
  window.addEventListener('keydown', prime, { once: true, capture: true });
}
