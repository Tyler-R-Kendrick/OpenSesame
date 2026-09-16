/**
 * Support question list: every authored QA scenario shares one shape —
 * ask the agent (or fall back to checked-in prose), and Show me runs the
 * authored GuideLang walkthrough for that answer.
 */

import type { ReactElement } from "react";
import {
  type GuideGoalDescriptor,
  type HelpTopic,
  guideGoal,
} from "../registry/goals.js";
import type { SupportController } from "../session.js";

export type SupportQuestion = {
  readonly id: string;
  readonly title: string;
  readonly ask: () => void;
  readonly showMe: () => void;
};

export function questionsFromTopics(
  topics: readonly HelpTopic[],
  support: SupportController,
  canAsk: boolean,
): SupportQuestion[] {
  const out: SupportQuestion[] = [];
  for (const topic of topics) {
    const named = guideGoal(topic.goal);
    if (!named) continue;
    out.push({
      id: topic.id,
      title: topic.title,
      ask: () => {
        if (canAsk) {
          void support.ask(topic.title);
          return;
        }
        support.answerFromAuthoredHelp(topic.title, topic.answer);
      },
      showMe: () => {
        void support.startGuide(named.guide, "authored");
      },
    });
  }
  return out;
}

/** Goals on this route that no listed help topic already covers. */
export function questionsFromGoals(
  goals: readonly GuideGoalDescriptor[],
  coveredGoalIds: ReadonlySet<string>,
  support: SupportController,
  canAsk: boolean,
): SupportQuestion[] {
  const out: SupportQuestion[] = [];
  for (const goal of goals) {
    if (coveredGoalIds.has(goal.id)) continue;
    out.push({
      id: `goal.${goal.id}`,
      title: goal.title,
      ask: () => {
        if (canAsk) {
          void support.ask(goal.title);
          return;
        }
        support.answerFromAuthoredHelp(
          goal.title,
          `A walkthrough can show you: ${goal.title}.`,
        );
      },
      showMe: () => {
        void support.startGuide(goal.guide, "authored");
      },
    });
  }
  return out;
}

export function SupportQuestions({
  query,
  searchId,
  onQueryChange,
  questions,
}: {
  query: string;
  searchId: string;
  onQueryChange: (next: string) => void;
  questions: readonly SupportQuestion[];
}): ReactElement {
  return (
    <section className="support__help" aria-label="Questions">
      <p className="support__section-label">Questions</p>
      <div className="f__shell support__search">
        <label className="visually-hidden" htmlFor={searchId}>
          Search questions
        </label>
        <input
          id={searchId}
          className="f__input"
          type="search"
          value={query}
          placeholder="Search questions"
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      {questions.length === 0 ? (
        <p className="hint">Nothing written matches that yet.</p>
      ) : null}
      {questions.map((question) => (
        <article key={question.id} className="support__topic">
          <button
            type="button"
            className="support__topic-open"
            onClick={question.ask}
          >
            {question.title}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={question.showMe}
          >
            Show me
          </button>
        </article>
      ))}
    </section>
  );
}
