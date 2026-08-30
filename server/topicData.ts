import patternsJson from '../data/topics/patterns.json';
import personJson from '../data/topics/words/person.json';
import placeJson from '../data/topics/words/place.json';
import orgJson from '../data/topics/words/org.json';
import thingJson from '../data/topics/words/thing.json';
import actJson from '../data/topics/words/act.json';
import guiseJson from '../data/topics/words/guise.json';
import pguiseJson from '../data/topics/words/pguise.json';
import modifierJson from '../data/topics/words/modifier.json';
import type { Pattern, TopicData, Word } from '../src/engine/topic';

/**
 * 素材ファイルを読むのはサーバーの仕事（engine は純粋に保つ）。
 * import で取り込むのは、dist-server に束ねたときファイルパスを気にしなくて済むため。
 */

type RawWord = { id: string; word: string; tags?: string[]; roles?: string[]; level?: number };

const norm = (cat: string, ws: RawWord[]): Word[] =>
  ws.map((w) => ({
    id: w.id, word: w.word, cat,
    tags: w.tags ?? [], roles: w.roles ?? [], level: w.level ?? 1,
  }));

export const topicData: TopicData = {
  slotCats: patternsJson.slotCats as Record<string, string>,
  patterns: patternsJson.patterns as unknown as Pattern[],
  pool: {
    person: norm('person', personJson.words),
    place: norm('place', placeJson.words),
    org: norm('org', orgJson.words),
    thing: norm('thing', thingJson.words),
    act: norm('act', actJson.words),
    guise: norm('guise', guiseJson.words),
    pguise: norm('pguise', pguiseJson.words),
    attr: norm('attr', modifierJson.attr.words),
    time: norm('time', modifierJson.time.words),
  },
};
