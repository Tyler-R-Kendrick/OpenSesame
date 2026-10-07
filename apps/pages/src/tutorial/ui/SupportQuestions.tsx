/**
 * Support question list: every authored QA scenario shares one shape —
 * ask the agent (or fall back to checked-in prose), and Show me runs the
 * authored GuideLang walkthrough for that answer.
 */

import {
  type GuideGoalDescriptor,
  type HelpTopic,
  guideGoal,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import type { ReactElement } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconArrowRight } from "../../components/Icons.js";
import type { SupportController } from "../session.js";

export type SupportQuestion = {
  readonly id: string;
  readonly title: string;
  readonly ask: () => void;
  /** Absent for written help that has no walkthrough (the gates). */
  readonly showMe: (() => void) | null;
};

export function questionsFromTopics(
  topics: readonly HelpTopic[],
  support: SupportController,
  canAsk: boolean,
): SupportQuestion[] {
  const out: SupportQuestion[] = [];
  for (const topic of topics) {
    const named = topic.goal ? guideGoal(topic.goal) : null;
    // A topic that names a goal no longer live is dropped; one that names none
    // is written help only.
    if (topic.goal && !named) continue;
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
      showMe: named
        ? () => {
            void support.startGuide(named.guide, "authored");
          }
        : null,
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
  questions,
}: {
  questions: readonly SupportQuestion[];
}): ReactElement {
  return (
    <section className="support__help" aria-label="Questions">
      <p className="support__section-label">Questions</p>
      {questions.length === 0 ? <p className="hint">No matches.</p> : null}
      {questions.map((question) => (
        <article key={question.id} className="support__topic">
          <button
            type="button"
            className="support__topic-open"
            onClick={question.ask}
          >
            {question.title}
          </button>
          {question.showMe ? (
            <IconKey label="Show me" small onClick={question.showMe}>
              <IconArrowRight size={16} />
            </IconKey>
          ) : null}
        </article>
      ))}
    </section>
  );
}
