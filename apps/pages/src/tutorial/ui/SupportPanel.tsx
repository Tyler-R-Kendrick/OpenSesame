import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconSupport, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import {
  GUIDE_GOALS,
  type GuideGoalDescriptor,
  guideGoal,
  helpTopicsForRoute,
  searchHelpTopics,
} from "../registry/goals.js";
import { guideRouteWithin } from "../registry/routes.js";
import type { SupportEntry } from "../session.js";
import { useSupport } from "../session.js";
import "../support.css";
import { RemoteSupportPreview } from "./RemoteSupportPreview.js";
import {
  Availability,
  GuideStatus,
  WebMcpStatus,
} from "./SupportPanelChrome.js";
import {
  SupportQuestions,
  questionsFromGoals,
  questionsFromTopics,
} from "./SupportQuestions.js";

const SPEAKER = {
  question: "you",
  answer: "support",
  note: "·",
} satisfies Record<SupportEntry["kind"], string>;

/**
 * Who said it, for anyone not reading the margin tag. The visible marker is
 * `aria-hidden` and the note marker is a bare interpunct, so without this a
 * screen reader hears a question and its answer as one undifferentiated run of
 * prose — the distinction would be carried by a mono tag and an accent colour,
 * which is colour-only by another name.
 */
const SPOKEN_SPEAKER = {
  question: "you asked",
  answer: "support answered",
  note: "note",
} satisfies Record<SupportEntry["kind"], string>;

function goalsForRoute(route: string): readonly GuideGoalDescriptor[] {
  return GUIDE_GOALS.filter(
    (goal) =>
      goal.routes.length === 0 ||
      goal.routes.some((candidate) => guideRouteWithin(route, candidate)),
  );
}

/**
 * In-product support, as a sheet over what you were already doing.
 *
 * Agent chat is the primary road: a question can be typed, or any listed QA
 * scenario can be asked the same way. Each scenario also carries Show me — an
 * authored GuideLang walkthrough that puts the app in tutorial mode. With no
 * on-device model and no configured endpoint the authored answers still land,
 * and Show me still runs; a model only makes the same graph conversational.
 *
 * Everything the model says is rendered as a React text node. There is no
 * `dangerouslySetInnerHTML` here, and there never may be: model prose is
 * untrusted text, and a support answer is exactly where an injected page would
 * try to spend markup.
 */
export function SupportPanel(): ReactElement {
  const { view, support } = useSupport();
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => support.close(), [support]);
  useModalFocus(true, sheetRef, closeRef, close);

  const askId = useId();
  const searchId = useId();
  const [question, setQuestion] = useState("");
  const [query, setQuery] = useState("");

  const topics = useMemo(
    () =>
      query.trim() ? searchHelpTopics(query) : helpTopicsForRoute(view.route),
    [query, view.route],
  );
  const goals = useMemo(() => goalsForRoute(view.route), [view.route]);

  const availability = view.availability;
  const canAsk = availability?.kind === "ready" && !view.thinking;

  const questions = useMemo(() => {
    const fromTopics = questionsFromTopics(topics, support, canAsk);
    const covered = new Set(topics.map((topic) => topic.goal));
    const fromGoals = query.trim()
      ? []
      : questionsFromGoals(goals, covered, support, canAsk);
    return [...fromTopics, ...fromGoals];
  }, [topics, goals, support, canAsk, query]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const asked = question;
    setQuestion("");
    void support.ask(asked);
  };

  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={close}
      />
      <section
        ref={sheetRef}
        className="sheet support"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and conflicts with the shared sheet layer
        role="dialog"
        aria-modal="true"
        aria-label="Support"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            <IconSupport size={20} />
          </span>
          <div className="sheet__grow">
            <h2>Support</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={close}
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="sheet__body support__body">
          <RemoteSupportPreview warning={view.warning} />
          <Availability
            availability={availability}
            ready={view.ready}
            onAcquire={() => void support.acquireModel()}
          />
          <GuideStatus />

          {/* The region is always here, even while empty. A live region created
              in the same paint as its first message is not reliably announced,
              which would lose exactly the turn that matters most: the first
              question somebody asks and the answer they get back. */}
          <section
            className="support__thread"
            aria-label="Conversation"
            aria-live="polite"
          >
            {view.transcript.map((entry) => (
              <article
                key={entry.id}
                className={`support__line support__line--${entry.kind}`}
                aria-label={SPOKEN_SPEAKER[entry.kind]}
              >
                <span className="support__who" aria-hidden="true">
                  {SPEAKER[entry.kind]}
                </span>
                <p className="support__text">{entry.text}</p>
                {entry.thoughts ? (
                  <details className="support__trace" aria-live="off">
                    <summary>Thoughts</summary>
                    <p className="support__trace-body">{entry.thoughts}</p>
                  </details>
                ) : null}
                {entry.computer.length > 0 ? (
                  <details className="support__trace" aria-live="off">
                    <summary>Computer</summary>
                    <ol className="support__computer">
                      {entry.computer.map((step, index) => (
                        <li key={`${step.title}:${index}`}>
                          <span className="support__computer-title">
                            {step.title}
                          </span>
                          {step.detail ? (
                            <p className="support__computer-detail">
                              {step.detail}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {entry.walkthroughs.length > 0 ? (
                  <div className="support__suggestions">
                    {entry.walkthroughs.map((walkthrough) => {
                      const named = guideGoal(walkthrough.goal);
                      if (!named) return null;
                      return (
                        <button
                          key={walkthrough.goal}
                          type="button"
                          className="btn btn--sm"
                          onClick={() =>
                            void support.startGuide(named.guide, "authored")
                          }
                        >
                          Show me: {walkthrough.title}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {entry.suggestions.length > 0 ? (
                  <div className="support__suggestions">
                    {entry.suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className="btn btn--sm btn--ghost"
                        disabled={!canAsk}
                        onClick={() => void support.ask(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </section>

          {view.transcript.length > 0 ? (
            <div className="actions">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => support.clear()}
              >
                Clear conversation
              </button>
            </div>
          ) : null}

          {view.thinking ? (
            <div className="support__pending">
              <output className="support__pending-read">Thinking…</output>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => support.cancel()}
              >
                Cancel
              </button>
            </div>
          ) : null}

          {view.error ? (
            <p className="note note--err" role="alert">
              {view.error}
            </p>
          ) : null}

          <SupportQuestions
            query={query}
            searchId={searchId}
            onQueryChange={setQuery}
            questions={questions}
          />

          <WebMcpStatus />
        </div>

        <div className="sheet__foot">
          <form className="support__composer" onSubmit={submit}>
            <label className="visually-hidden" htmlFor={askId}>
              Ask about this screen
            </label>
            <div className="f__shell">
              <input
                id={askId}
                className="f__input"
                type="text"
                value={question}
                maxLength={SUPPORT_LIMITS.maxQuestionChars}
                placeholder={
                  canAsk ? "Ask about this screen" : "Questions only"
                }
                disabled={!canAsk}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </div>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!canAsk || question.trim().length === 0}
            >
              Ask
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
