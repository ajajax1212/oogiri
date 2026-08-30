import { describe, expect, it } from 'vitest';
import { mulberry32, TopicSource, type TopicData } from './topic';
import type { BroughtWord, Handmade, TopicRecord } from './types';

/**
 * お題の生成（TOPIC-GEN.md）。
 *
 * 素材は最小限を手で置く。本物の data/ を読むと、落ちたときに
 * 生成の仕組みが悪いのか素材が悪いのか切り分けられない。
 */

const w = (id: string, word: string, cat: string, tags: string[] = [], roles: string[] = []) =>
  ({ id, word, cat, tags, roles, level: 1 });

const data: TopicData = {
  slotCats: { PERSON: 'person', ORG: 'org', THING: 'thing' },
  patterns: [
    {
      id: 'x-01', type: 'attr', template: '{PERSON}が経営している{ORG}。{E}',
      slots: ['PERSON', 'ORG'], endings: [{ text: 'どんな{ORG}？', fallback: 'どんなの？' }], maxLen: 40,
    },
    {
      id: 'x-02', type: 'attr', template: '{PERSON}が作った{THING}。{E}',
      slots: ['PERSON', 'THING'], endings: ['商品名は？'], deny: { THING: ['nonproduct'] }, maxLen: 40,
    },
    {
      id: 'y-01', type: 'hate', template: 'こんな{ORG}は嫌だ。{E}',
      slots: ['ORG'], endings: ['どんなの？'], maxLen: 40, noBrought: true,
    },
    {
      id: 'y-02', type: 'hate', template: 'こんな{PERSON}は嫌だ。{E}',
      slots: ['PERSON'], endings: ['どんなの？'], maxLen: 40, noBrought: true,
    },
  ],
  pool: {
    person: [
      w('pe-1', '部長', 'person', ['職場']), w('pe-2', '課長', 'person', ['職場']),
      w('pe-3', '住職', 'person', ['儀式']), w('pe-4', '巫女', 'person', ['儀式']),
    ],
    org: [
      w('or-1', '銀行', 'org', ['職場']), w('or-2', '出版社', 'org', ['職場']),
      w('or-3', '神社', 'org', ['儀式']), w('or-4', '本堂', 'org', ['儀式']),
    ],
    thing: [
      w('th-1', '名刺', 'thing', ['職場']),
      w('th-2', '賞状', 'thing', ['職場'], ['nonproduct']),
      w('th-3', 'とても長い名前の置物', 'thing', ['職場']),
    ],
  },
};

const src = (seed = 1) => new TopicSource(data, mulberry32(seed));

/** 何度も引いて、条件を満たす1本を見つける（乱数任せの検査を安定させる） */
function collect(n: number, seed = 1, brought: BroughtWord[] = [], hand: Handmade[] = []) {
  const s = src(seed);
  const history: TopicRecord[] = [];
  for (let i = 0; i < n; i++) {
    const r = s.next(history, brought, hand);
    if (r) history.push(r);
  }
  return history;
}

describe('組み合わせ規則', () => {
  it('場を共有していない語どうしは組まない', () => {
    for (const r of collect(60)) {
      // 職場の語と儀式の語が同じお題に入ることはない
      const hasWork = r.tags.includes('職場');
      const hasRite = r.tags.includes('儀式');
      expect(hasWork && hasRite).toBe(false);
    }
  });

  it('骨格の deny を守る（商品にならない物は「作った」に入れない）', () => {
    for (const r of collect(60)) {
      if (r.patternId === 'x-02') expect(r.wordIds).not.toContain('th-2');
    }
  });

  it('語尾が長い語を繰り返すときは fallback に落とす', () => {
    const texts = collect(60).filter((r) => r.patternId === 'x-01').map((r) => r.text);
    for (const t of texts) {
      // 「どんな銀行？」は通すが、6文字以上の語は繰り返さない
      expect(t).not.toMatch(/どんな.{6,}？/);
    }
  });

  it('プールが尽きるまで同じ語を使い回さない（非復元）', () => {
    // 素材は各カテゴリ4語。2問ぶんなら必ず全部ちがう語になる
    const h = collect(2);
    const ids = h.flatMap((r) => r.wordIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('同じ骨格を続けて出さない', () => {
    const h = collect(20);
    for (let i = 1; i < h.length; i++) {
      expect(h[i].patternId).not.toBe(h[i - 1].patternId);
    }
  });
});

describe('引き直し', () => {
  it('捨てた骨格はその部屋で二度と使わない', () => {
    const s = src(3);
    const history: TopicRecord[] = [];
    const first = s.next(history, [])!;
    history.push(first);
    first.discarded = true;
    s.burn(first);

    for (let i = 0; i < 30; i++) {
      const r = s.next(history, []);
      if (r) { expect(r.patternId).not.toBe(first.patternId); history.push(r); }
    }
  });
});

describe('持ち寄り語', () => {
  const brought: BroughtWord[] = [
    { id: 'b1', word: 'たけし', cat: 'person', byId: 'p0' },
    { id: 'b2', word: '駅前のドトール', cat: 'place', byId: 'p1' },
  ];

  it('使われた回は broughtIds に記録され、同じ語は二度出ない', () => {
    const h = collect(40, 7, brought);
    const used = h.flatMap((r) => r.broughtIds);
    expect(new Set(used).size).toBe(used.length);
  });

  it('1つのお題に持ち寄り語は1つまで', () => {
    for (const r of collect(40, 7, brought)) expect(r.broughtIds.length).toBeLessThanOrEqual(1);
  });

  it('noBrought の骨格には入れない', () => {
    for (const r of collect(60, 11, brought)) {
      if (r.patternId === 'y-01') expect(r.broughtIds).toHaveLength(0);
    }
  });
});

describe('手書きお題', () => {
  const hand: Handmade[] = [
    { id: 'h1', text: '手で書いたお題その1', byId: 'p0' },
    { id: 'h2', text: '手で書いたお題その2', byId: 'p1' },
  ];

  it('自動生成に混ざって出る', () => {
    const h = collect(40, 5, [], hand);
    expect(h.some((r) => r.patternId === 'handmade')).toBe(true);
  });

  it('同じお題は二度出ない', () => {
    const used = collect(60, 5, [], hand).filter((r) => r.patternId === 'handmade');
    expect(new Set(used.map((r) => r.id)).size).toBe(used.length);
  });

  it('手書きが続けて出ることはない', () => {
    const h = collect(60, 5, [], hand);
    for (let i = 1; i < h.length; i++) {
      if (h[i].patternId === 'handmade') expect(h[i - 1].patternId).not.toBe('handmade');
    }
  });

  it('3問続けて引き直されたら、確実に手書きから出す', () => {
    const s = src(2);
    const history: TopicRecord[] = [];
    for (let i = 0; i < 3; i++) {
      const r = s.next(history, [])!;
      r.discarded = true;
      s.burn(r);
      history.push(r);
    }
    const next = s.next(history, [], hand);
    expect(next?.patternId).toBe('handmade');
  });

  it('投稿が無ければ普通に生成する', () => {
    const h = collect(10, 5, [], []);
    expect(h.every((r) => r.patternId !== 'handmade')).toBe(true);
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('乱数', () => {
  it('同じシードなら同じお題が出る（本番の再現に要る）', () => {
    expect(collect(10, 42).map((r) => r.text)).toEqual(collect(10, 42).map((r) => r.text));
  });
  it('シードが違えば違うお題になる', () => {
    expect(collect(10, 1).map((r) => r.text)).not.toEqual(collect(10, 2).map((r) => r.text));
  });
});
