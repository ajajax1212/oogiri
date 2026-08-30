import { useState } from 'react';
import { LIMIT } from '../net/events';

/**
 * 参加者が手書きお題を投稿するフォーム（TOPIC-GEN.md §9.1）。
 *
 * 投稿されたお題は自動生成に混ざって出る。**他人が出したお題の本文は配られない**
 * ので、ここに出るのは自分が出した分だけ。出るまで知らないから面白い。
 *
 * ロビーでもゲーム中でも投稿できる。お題を思いつくのは遊んでいる最中だから。
 */
export function TopicForm({
  myTopics, count, post, remove,
}: {
  myTopics: { id: string; text: string }[];
  count: number;
  post: (text: string) => Promise<{ ok: boolean }>;
  remove: (id: string) => Promise<{ ok: boolean }>;
}) {
  const [text, setText] = useState('');
  const full = myTopics.length >= LIMIT.topicsPerPlayer;

  const send = async () => {
    if (!text.trim()) return;
    const r = await post(text);
    if (r.ok) setText('');
  };

  return (
    <div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 14 }}>
        自分で考えたお題を出せます（1人{LIMIT.topicsPerPlayer}問まで）。自動で作られたお題に混ざって出ます。
        <strong style={{ color: 'var(--gold-hi)' }}> 誰が出したかは分かりません。</strong>
      </p>
      <div className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, LIMIT.topicMax))}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={`お題（${LIMIT.topicMin}〜${LIMIT.topicMax}文字）`}
          disabled={full}
          style={{ flex: 1, minWidth: 260 }}
        />
        <button onClick={send} disabled={full || !text.trim()}>出す</button>
      </div>

      <div className="col" style={{ gap: 6, marginTop: 12 }}>
        {myTopics.map((t) => (
          <span key={t.id} className="chip" style={{ alignSelf: 'flex-start' }}>
            {t.text}
            <button onClick={() => remove(t.id)}>×</button>
          </span>
        ))}
      </div>

      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        {count > 0 ? `この部屋に ${count}問 たまっています` : 'まだ誰も出していません'}
        {full && '　（あなたはもう出せません）'}
      </p>
    </div>
  );
}
