import {
  type LibraryOptions,
  goalOffered,
  tutorialStartsFrom,
} from "@opensesame/app-core/tutorial/registry/areas.js";
import { searchHelpTopics } from "@opensesame/app-core/tutorial/registry/goals-search.js";
import {
  type GuideGoalDescriptor,
  type HelpTopic,
  guideGoal,
  helpTopicsForRoute,
  mergedGuideGoals,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import { scopeApplies } from "@opensesame/app-core/tutorial/registry/routes.js";
import {
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { IconKey } from "../../components/IconKey.js";
import { IconSupport, IconTrash, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import type { SupportEntry } from "../session.js";
import { useSupport } from "../session.js";
import { SupportComposer } from "./SupportComposer.js";
import "../support.css";
import { RemoteSupportPreview } from "./RemoteSupportPreview.js";
import { Availability } from "./SupportPanelChrome.js";
import {
  SupportQuestions,
  questionsFromGoals,
  questionsFromTopics,
} from "./SupportQuestions.js";
import { SupportTutorials } from "./SupportTutorials.js";
import { useTutorialGate } from "./use-tutorial-gate.js";

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

/**
 * The scenarios this route offers: the goals that fit the screen, minus the
 * ones only the library lists, and only those the Tutorials tab would offer
 * too (`useTutorialGate`) — a tour of a section that is not drawn, or of a
 * row this device has no use for, is not a question to ask.
 */
function goalsForRoute(
  route: string,
  gate: LibraryOptions,
): readonly GuideGoalDescriptor[] {
  return mergedGuideGoals().filter(
    (goal) =>
      goal.libraryOnly !== true &&
      goalOffered(goal, gate) &&
      scopeApplies(goal.routes, route),
  );
}

/**
 * The written help worth listing on `route`: a topic whose tutorial is not
 * offered is dropped, and one whose tutorial cannot start from this screen
 * keeps its written answer without a Show me — a search reaches every topic,
 * and a gate cannot start the shell's tours (ADR 0166).
 */
function topicsHere(
  topics: readonly HelpTopic[],
  route: string,
  gate: LibraryOptions,
): readonly HelpTopic[] {
  return topics.flatMap((topic) => {
    const named = topic.goal ? guideGoal(topic.goal) : null;
    if (named === null) return [topic];
    if (!goalOffered(named, gate)) return [];
    return [
      tutorialStartsFrom(named, route) ? topic : { ...topic, goal: null },
    ];
  });
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

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"ask" | "tutorials">("ask");

  const gate = useTutorialGate();
  const { plan } = useComposition();
  // Ask when this installation approved local or remote AI. Search when the
  // written help is all this build can offer. The composer's verb stays
  // Search until a model is actually ready to answer.
  const askTab =
    plan?.capabilities["support.local-ai"]?.approved === true ||
    plan?.capabilities["support.remote-ai"]?.approved === true
      ? "Ask"
      : "Search";
  const topics = useMemo(
    () =>
      topicsHere(
        query.trim() ? searchHelpTopics(query) : helpTopicsForRoute(view.route),
        view.route,
        gate,
      ),
    [query, view.route, gate],
  );
  const goals = useMemo(
    () => goalsForRoute(view.route, gate),
    [view.route, gate],
  );

  const availability = view.availability;
  // Asking must work with no local model: refuseUntrustedProposal and authored
  // topic fallbacks run before or without ensureEngine.
  const canAsk = !view.thinking;

  const questions = useMemo(() => {
    const fromTopics = questionsFromTopics(topics, support, canAsk);
    const covered = new Set(topics.flatMap((topic) => topic.goal ?? []));
    const fromGoals = query.trim()
      ? []
      : questionsFromGoals(goals, covered, support, canAsk);
    return [...fromTopics, ...fromGoals];
  }, [topics, goals, support, canAsk, query]);

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
            onAcquire={() => void support.acquireModel()}
          />

          <div className="support__tabs" role="tablist" aria-label="Support">
            {(["ask", "tutorials"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`support-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`support-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className={`support__tab${tab === id ? " is-active" : ""}`}
                onClick={() => setTab(id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                    return;
                  }
                  event.preventDefault();
                  const next = id === "ask" ? "tutorials" : "ask";
                  setTab(next);
                  document.getElementById(`support-tab-${next}`)?.focus();
                }}
              >
                {id === "ask" ? askTab : "Tutorials"}
              </button>
            ))}
          </div>

          {tab === "tutorials" ? (
            <div
              role="tabpanel"
              id="support-panel-tutorials"
              aria-labelledby="support-tab-tutorials"
            >
              <SupportTutorials
                query={query}
                route={view.route}
                support={support}
              />
            </div>
          ) : (
            <div
              className="support__ask"
              role="tabpanel"
              id="support-panel-ask"
              aria-labelledby="support-tab-ask"
            >
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
                              className="btn btn--sm choice"
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
                            className="btn btn--sm btn--ghost choice"
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
                  <IconKey
                    label="Clear conversation"
                    small
                    onClick={() => support.clear()}
                  >
                    <IconTrash size={16} />
                  </IconKey>
                </div>
              ) : null}

              {view.thinking ? (
                <div className="support__pending">
                  <output className="support__pending-read">Thinking…</output>
                  <IconKey
                    label="Cancel"
                    small
                    onClick={() => support.cancel()}
                  >
                    <IconX size={16} />
                  </IconKey>
                </div>
              ) : null}

              <SupportQuestions questions={questions} />
            </div>
          )}
        </div>
        <div className="sheet__foot">
          <SupportComposer query={query} onQueryChange={setQuery} />
        </div>
      </section>
    </div>
  );
}
