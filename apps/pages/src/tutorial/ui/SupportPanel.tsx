import type { SupportAgentAvailability } from "@opensesame/support-agent";
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
  type HelpTopic,
  guideGoal,
  helpTopicsForRoute,
  searchHelpTopics,
} from "../registry/goals.js";
import { guideRouteWithin } from "../registry/routes.js";
import type { SupportEntry } from "../session.js";
import { useSupport } from "../session.js";
import "../support.css";
import { UNAVAILABLE_TEXT } from "./messages.js";

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
 * The written help, the search over it and the walkthroughs are rendered
 * whether or not anything can answer a typed question: the knowledge is
 * checked-in data, and a model only makes it conversational. A browser with no
 * on-device model and no configured endpoint opens this panel and still gets
 * helped, which is why the unavailable notice sits *above* the help rather
 * than in place of it.
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const asked = question;
    setQuestion("");
    void support.ask(asked);
  };

  const runTopic = (topic: HelpTopic) => {
    support.answerFromAuthoredHelp(topic.title, topic.answer);
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
          <TransportNote warning={view.warning} />
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
                  <details className="support__trace">
                    <summary>Thoughts</summary>
                    <p className="support__trace-body">{entry.thoughts}</p>
                  </details>
                ) : null}
                {entry.computer.length > 0 ? (
                  <details className="support__trace">
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

          <section className="support__help" aria-label="Written help">
            <p className="support__section-label">Help</p>
            <div className="f__shell support__search">
              <label className="visually-hidden" htmlFor={searchId}>
                Search help
              </label>
              <input
                id={searchId}
                className="f__input"
                type="search"
                value={query}
                placeholder="Search help"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {topics.length === 0 ? (
              <p className="hint">Nothing written matches that yet.</p>
            ) : null}
            {topics.map((topic) => {
              const shown = topic.goal ? guideGoal(topic.goal) : null;
              return (
                <article key={topic.id} className="support__topic">
                  <button
                    type="button"
                    className="support__topic-open"
                    onClick={() => runTopic(topic)}
                  >
                    {topic.title}
                  </button>
                  {shown ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() =>
                        void support.startGuide(shown.guide, "authored")
                      }
                    >
                      Show me
                    </button>
                  ) : null}
                </article>
              );
            })}
          </section>

          {goals.length > 0 ? (
            <section className="support__goals" aria-label="Walkthroughs">
              <p className="support__section-label">Walkthroughs</p>
              {goals.map((goal) => (
                <article key={goal.id} className="support__goal">
                  <span className="support__goal-title">{goal.title}</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={() =>
                      void support.startGuide(goal.guide, "authored")
                    }
                  >
                    Show me
                  </button>
                </article>
              ))}
            </section>
          ) : null}
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
                  canAsk ? "Ask about this screen" : "Written help only"
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

/** The one line that says an answer will leave this device. */
function TransportNote({
  warning,
}: { warning: string | null }): ReactElement | null {
  if (!warning) return null;
  return <p className="note note--warn support__egress">{warning}</p>;
}

function Availability({
  availability,
  ready,
  onAcquire,
}: {
  availability: SupportAgentAvailability | null;
  ready: boolean;
  onAcquire: () => void;
}): ReactElement | null {
  if (availability === null) {
    return (
      <p className="hint">
        {ready ? "Nothing has reported yet." : "Checking what can answer here…"}
      </p>
    );
  }
  if (availability.kind === "ready") return null;
  if (availability.kind === "downloading") {
    const percent = Math.round(availability.progress * 100);
    return (
      <div className="support__download">
        <output className="support__download-read">
          Downloading the on-device model — {percent}%
        </output>
        {/* The output beside it already reads the whole sentence; an unnamed
            progressbar would only announce "progress bar, 40". */}
        <progress
          className="support__progress"
          max={100}
          value={percent}
          aria-hidden="true"
        />
      </div>
    );
  }
  if (availability.kind === "downloadable") {
    return (
      <div className="support__download">
        <p className="hint">
          This browser can answer on the device once its model has been
          downloaded. Nothing is fetched until you ask for it.
        </p>
        <button type="button" className="btn btn--primary" onClick={onAcquire}>
          Download the on-device model
        </button>
      </div>
    );
  }
  return (
    <p className="hint support__unavailable">
      {UNAVAILABLE_TEXT[availability.reason]}
    </p>
  );
}

function GuideStatus(): ReactElement | null {
  const { view, support } = useSupport();
  const guide = view.guide;
  const live =
    guide?.status === "running" ||
    guide?.status === "waiting" ||
    guide?.status === "paused";
  if (!guide || !live) return null;
  const running = guide.status !== "paused";
  const title = guide.goal
    ? (guideGoal(guide.goal)?.title ?? guide.goal)
    : "Walkthrough";
  return (
    <section className="support__guide" aria-label="Walkthrough in progress">
      <p className="support__guide-head">
        <span className="support__goal-title">{title}</span>
        <span className="support__guide-step">
          {guide.status === "paused" ? "paused · " : ""}
          step {Math.min(guide.index + 1, guide.total)} of {guide.total}
        </span>
      </p>
      {guide.message ? <p className="support__text">{guide.message}</p> : null}
      <div className="actions">
        {running ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => support.pauseGuide()}
          >
            Pause
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => support.stopGuide()}
        >
          Stop
        </button>
      </div>
    </section>
  );
}
