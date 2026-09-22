/**
 * Deployment setup — one optional ceremony.
 *
 * Nothing here is a gate. This static app is complete without a backend (ADR
 * 0090): a first visitor signs in through the compiled-in broker, continues
 * as a guest, or seals a local vault, and never has to answer an operator's
 * question first. This screen is reached on purpose — `Deployment setup`
 * from the sign-in screen's foot.
 *
 * The first tab is always `capabilities` — what this installation runs, as
 * a draft reviewed and applied (CONSENT-03). Every further tab is a
 * `setup-panel` contribution registered by a capability the person has
 * applied: nothing is hardcoded here any more, so a deselected capability
 * has no tab. Every tab writes its record as it is answered — `settings.v1`,
 * or the connector directory's own — every tab is skippable, and "Skip all"
 * takes the whole tour off the table. Skipping is recorded so "looked and
 * passed" stays distinct from "never looked"; it is never consent. The foot
 * is icon keys for previous / skip / next, and the shared `.go` Finish.
 *
 * Designed in `docs/design/first-run-setup/`.
 */

import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconSkip,
  IconSkipAll,
  IconX,
} from "../components/Icons.js";
import { Wordmark } from "../components/Wordmark.js";
import { useContributions } from "../lib/configuration/capabilities-ports.js";
import { landFocus } from "../lib/focus.js";
import { loadSettings, signInMethods } from "../lib/settings.js";
import { completeSetup } from "../lib/setup.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { CapabilitySetup } from "./capabilities/CapabilitySetup.js";
import { KeepIt } from "./setup/KeepIt.js";
import "./setup.css";

/** One tab: the fixed capabilities tab, or a `setup-panel` contribution. */
export type SetupPanel = Readonly<{
  id: string;
  tab: string;
  rail: string;
  Panel: ComponentType;
  order?: number;
}>;

export const CAPABILITIES_STEP = "capabilities";

function useContributedPanels(): readonly SetupPanel[] {
  return useContributions("setup-panel").map((entry) => ({
    id: entry.id,
    tab: entry.tab,
    rail: entry.rail,
    Panel: entry.Panel,
    order: entry.order,
  }));
}

export const setupScreenDependencies = {
  completeSetup,
  loadSettings,
  /** The tabs after `capabilities` — a seam so a suite can register a fixture. */
  useSetupPanels: useContributedPanels,
};

export type SetupRoad = "setup";

/** A tab of the ceremony: `capabilities`, or a contribution's id. */
export type SetupStep = string;

export function SetupScreen({
  onDone,
  step,
  join = false,
}: {
  /** Back to the sign-in screen — after finishing, or by backing out. */
  onDone: () => void;
  /**
   * The tab to open on — a road that knows its concern (the no-way-in notice)
   * lands on it directly; anything else takes the tour from the top.
   */
  step?: SetupStep;
  /** Arrive on the join road: a managed instance's required roots to accept. */
  join?: boolean;
}) {
  useSupportRoute("/setup");
  const finishRef = useGuideTarget<HTMLButtonElement>("setup.finish");
  const [finishing, setFinishing] = useState(false);
  const contributed = setupScreenDependencies.useSetupPanels();
  const STEPS: readonly SetupPanel[] = [
    {
      id: CAPABILITIES_STEP,
      tab: CAPABILITIES_STEP,
      rail: "Capabilities",
      Panel: CapabilitySetup,
    },
    ...[...contributed].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    ),
  ];
  const [rawIndex, setIndex] = useState(() =>
    Math.max(
      0,
      STEPS.findIndex((entry) => entry.id === step),
    ),
  );
  // A contribution can leave between renders (a capability retired); the
  // tab strip never points past its end.
  const index = Math.min(rawIndex, STEPS.length - 1);
  const [skipped, setSkipped] = useState<SetupStep[]>([]);
  const frameRef = useRef<HTMLDivElement>(null);

  // The terminal commit owns the landing: nothing here is required, so Enter
  // finishes, and Shift+Tab walks back up into the tabs. The first control
  // in a step's body can be a Remove, which an arrival must not land on.
  useEffect(() => {
    landFocus(frameRef.current?.querySelector(".go"));
  }, []);

  const verb = finishing ? "Saving…" : "Finish setup";

  function finish(skippedSteps: readonly SetupStep[]) {
    // The answers already live in `settings.v1` — every step writes there as
    // it is touched, because the screens that read them do too. The record
    // only says which roads were taken and which were stepped past, so a
    // later screen can tell "nobody set this up" from "the operator
    // deliberately runs it this way".
    const settings = setupScreenDependencies.loadSettings();
    const methods = signInMethods(settings);
    setFinishing(true);
    void setupScreenDependencies
      .completeSetup({
        ways: [
          ...(methods.builtin ? ["builtin"] : []),
          ...methods.providers.map((idp) => idp.providerId || "oidc"),
        ],
        service: Boolean(settings.identityApi.trim()),
        skipped: [...skippedSteps],
      })
      .catch(() => {
        // The record is a convenience, not a gate: a browser that cannot
        // persist it will ask again next time, which the unlock screen already
        // warns about. Never trap the operator on the last step for it.
      })
      .finally(onDone);
  }

  function skipStep() {
    const current = STEPS[index];
    if (!current) return;
    const next = [...skipped, current.id];
    setSkipped(next);
    if (index + 1 < STEPS.length) setIndex(index + 1);
    else finish(next);
  }

  function skipAll() {
    finish([...skipped, ...STEPS.slice(index).map((step) => step.id)]);
  }

  function stepBack() {
    if (index <= 0) return;
    setIndex(index - 1);
  }

  const current = STEPS[index] ?? STEPS[0];
  const atStart = index <= 0;
  const atEnd = index + 1 >= STEPS.length;

  return (
    <div className="setup">
      <div className="setup__frame" ref={frameRef}>
        <div className="setup__bar">
          <Wordmark className="setup__wordmark" />
          {/* Backing out changes nothing: every step writes to settings as it
              is answered, and nothing here was ever required. */}
          <button
            type="button"
            className="icon-btn setup__back"
            aria-label="Close"
            title="Close"
            onClick={onDone}
          >
            <IconX size={18} />
          </button>
          <button
            type="button"
            className="icon-btn setup__back setup__skipall"
            disabled={finishing}
            aria-label="Skip all"
            title="Skip all"
            onClick={skipAll}
          >
            <IconSkipAll size={18} />
          </button>
        </div>

        {/* The rail and the tabs pin to the frame, above the scrollport —
            a step the body scrolled past would otherwise take its tab
            with it, stranding the later steps on a phone. */}
        <div className="setup__chrome">
          <div className="steps" aria-label="Setup steps">
            {STEPS.map((entry, at) => (
              <div
                key={entry.id}
                className={`steps__seg${
                  at < index ? " is-done" : at === index ? " is-now" : ""
                }`}
              >
                <span className="steps__bar" />
                <span className="steps__label">{`${at + 1} · ${entry.rail}`}</span>
              </div>
            ))}
          </div>

          <div className="setup__tabs" role="tablist" aria-label="Setup step">
            {STEPS.map((entry, at) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={at === index}
                className={`setup__tab${
                  at === index ? " setup__tab--active" : ""
                }`}
                onClick={() => setIndex(at)}
              >
                {entry.tab}
              </button>
            ))}
          </div>
        </div>

        <main className="setup__body" id="main">
          {/* The capabilities tab takes the join road as a prop; a
              contributed panel takes nothing — it reads its own settings. */}
          {current?.id === CAPABILITIES_STEP ? (
            <CapabilitySetup join={join} />
          ) : current ? (
            <current.Panel />
          ) : null}

          {/* Not a question — an offer with no wrong answer, below the
                  step that is on screen and withheld entirely where the
                  browser will not install. ADR 0086. */}
          <GuideTarget id="setup.keep">
            <KeepIt />
          </GuideTarget>
        </main>

        <div className="setup__foot">
          <div className="setup__foot-start">
            <button
              type="button"
              className="icon-btn"
              disabled={finishing || atStart}
              aria-label="Previous step"
              title="Previous step"
              onClick={stepBack}
            >
              <IconChevronLeft size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={finishing}
              aria-label="Skip this step"
              title="Skip this step"
              onClick={skipStep}
            >
              <IconSkip size={18} />
            </button>
          </div>
          <div className="setup__foot-end">
            {atEnd ? null : (
              <button
                type="button"
                className="icon-btn"
                disabled={finishing}
                aria-label="Next step"
                title="Next step"
                onClick={() => setIndex(index + 1)}
              >
                <IconChevronRight size={18} />
              </button>
            )}
            <div className="go-row">
              <button
                ref={finishRef}
                type="button"
                className="go"
                disabled={finishing}
                aria-busy={finishing}
                aria-label={verb}
                title={verb}
                onClick={() => finish(skipped)}
              >
                <IconCheck size={18} />
              </button>
              <span className="go-verb" aria-hidden="true">
                {verb}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
