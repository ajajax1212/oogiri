import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TopicRecord } from '../src/engine/types';

/**
 * お題が「出た」と「引き直された」を記録する。
 *
 * 引き直しは、**全員が「これは違う」と言った**という一番正直な評価なので、
 * どの型・どの骨格で起きたかが分かれば、次に素材と骨格のどちらへ手を入れるか決まる
 * （TOPIC-GEN.md §12）。遊んでいる最中に人が覚えておく話ではない。
 *
 * 出し先は2つ。
 * - `logs/topics.jsonl` … 手元で `npm.cmd run topics:report` に食わせるため
 * - 標準出力 … Render は書いたファイルを再起動で捨てるので、本番はこちらが頼り。
 *   ダッシュボードで `[topic]` を検索すれば拾える
 *
 * **お題の文以外の個人的なものは書かない。** プレイヤー名もフリップの中身も残さない。
 */

const DIR = path.join(process.cwd(), 'logs');
const FILE = path.join(DIR, 'topics.jsonl');

export type TopicEvent = 'served' | 'discarded';

type Row = {
  at: string;
  event: TopicEvent;
  code: string;
  patternId: string;
  type: string;
  endingId: string | null;
  wordIds: string[];
  broughtIds: string[];
  text: string;
  players: number;
};

let warned = false;

export function logTopic(
  event: TopicEvent,
  code: string,
  rec: TopicRecord,
  players: number,
): void {
  const row: Row = {
    at: new Date().toISOString(),
    event,
    code,
    patternId: rec.patternId,
    type: rec.type,
    endingId: rec.endingId,
    wordIds: rec.wordIds,
    broughtIds: rec.broughtIds,
    text: rec.text,
    players,
  };

  // 引き直しだけ目立たせる。出た方は数えるためだけなので静かに
  if (event === 'discarded') {
    console.log(`[topic] 引き直し ${rec.patternId}(${rec.type}) ${rec.text}`);
  } else {
    console.log(`[topic] 出題 ${rec.patternId}(${rec.type}) ${rec.text}`);
  }

  // 書けなくてもゲームは続ける。ログのために進行を止めない
  void (async () => {
    try {
      await mkdir(DIR, { recursive: true });
      await appendFile(FILE, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn('[topic] ログを書けない（以後この警告は出さない）:', e);
      }
    }
  })();
}
