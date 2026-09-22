/**
 * Ranking and search over the authored help topics.
 *
 * A browser with no model still has to answer a typed question, so the
 * ranking is a small deterministic index over the same corpus the guides
 * use: stem the words, weight a keyword above a title and a title above an
 * answer, and refuse to rank on stopwords alone.
 */

import type { HelpTopic } from "./goals.js";
import { mergedHelpTopics } from "./goals.js";
import type { GuideRouteId } from "./routes.js";
import { guideRouteWithin } from "./routes.js";

/**
 * Words that carry no topic on their own. A question is mostly these, and a
 * ranking that counted them would find every topic equally relevant.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "get",
  "have",
  "here",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "one",
  "or",
  "our",
  "should",
  "so",
  "the",
  "there",
  "this",
  "to",
  "up",
  "want",
  "we",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

/** Lowercase word stems: plural and progressive endings dropped. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const word = stem(raw);
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

const KEYWORD_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const ANSWER_WEIGHT = 1;
/** A keyword hit, or a title word plus anything else, is a confident match. */
const STRONG_SCORE = 3;

type IndexedTopic = {
  readonly topic: HelpTopic;
  readonly keywords: ReadonlySet<string>;
  readonly title: ReadonlySet<string>;
  readonly answer: ReadonlySet<string>;
};

function indexTopic(topic: HelpTopic): IndexedTopic {
  return {
    topic,
    keywords: new Set(topic.keywords.flatMap((keyword) => tokenize(keyword))),
    title: new Set(tokenize(topic.title)),
    answer: new Set(tokenize(topic.answer)),
  };
}

/** Cached until the live help moves. */
let index: readonly IndexedTopic[] = [];
let indexedFrom: readonly HelpTopic[] | null = null;

/**
 * The lexical index over the live help, rebuilt when the live help moves.
 *
 * The live list is replaced wholesale whenever a capability's topics join or
 * leave, so comparing identity is exact; comparing length and first entry
 * would miss a swap that kept both.
 */
function helpIndex(): readonly IndexedTopic[] {
  const topics = mergedHelpTopics();
  if (indexedFrom !== topics) {
    index = topics.map(indexTopic);
    indexedFrom = topics;
  }
  return index;
}

export type RankedHelpTopic = {
  readonly topic: HelpTopic;
  readonly score: number;
  /** Confident enough to stand in for an answer that cited nothing. */
  readonly strong: boolean;
};

function scoreTopic(indexed: IndexedTopic, words: readonly string[]): number {
  let score = 0;
  for (const word of words) {
    if (indexed.keywords.has(word)) score += KEYWORD_WEIGHT;
    else if (indexed.title.has(word)) score += TITLE_WEIGHT;
    else if (indexed.answer.has(word)) score += ANSWER_WEIGHT;
  }
  return score;
}

/**
 * The written help that answers a question, best first. Lexical, offline and
 * deterministic: a word of the question against each topic's authored
 * keywords, title and answer. This is the retrieval step that puts the
 * checked-in answer in front of a model before it is asked — and, when a model
 * cites nothing, decides whether a written answer can stand in for it.
 */
export function rankHelpTopics(
  question: string,
  route: GuideRouteId | null = null,
): readonly RankedHelpTopic[] {
  const words = tokenize(question);
  if (words.length === 0) return [];
  const ranked: RankedHelpTopic[] = [];
  for (const indexed of helpIndex()) {
    const { topic } = indexed;
    const scoped =
      route === null ||
      topic.routes.length === 0 ||
      topic.routes.some((candidate) => guideRouteWithin(route, candidate));
    if (!scoped) continue;
    const score = scoreTopic(indexed, words);
    if (score === 0) continue;
    ranked.push({ topic, score, strong: score >= STRONG_SCORE });
  }
  // A stable sort keeps authored order among equals.
  return ranked.sort((left, right) => right.score - left.score);
}

/**
 * Search over authored help: ranked by the words that match, with the old
 * substring match kept as the fallback so a fragment of a title still finds
 * it. No index, no model, works offline.
 */
export function searchHelpTopics(query: string): readonly HelpTopic[] {
  const needle = query.trim().toLowerCase();
  const topics = mergedHelpTopics();
  if (needle.length === 0) return topics;
  const ranked = rankHelpTopics(needle).map((entry) => entry.topic);
  if (ranked.length > 0) return ranked;
  return topics.filter(
    (topic) =>
      topic.title.toLowerCase().includes(needle) ||
      topic.answer.toLowerCase().includes(needle),
  );
}
