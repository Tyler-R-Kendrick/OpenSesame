/**
 * Deployment setup — one optional ceremony.
 *
 * Nothing here is a gate. This static app is complete without a backend (ADR
 * 0090): a first visitor signs in through the compiled-in broker, continues
 * as a guest, or seals a local vault, and never has to answer an operator's
 * question first. This screen is reached on purpose — `Deployment setup`
 * from the sign-in screen's foot.
 *
 * The operator road is a tab per concern (ADR 0114): connectors
 * (ADR 0115), ai, identity, mfa. Backups and sync were tabs once, but both
 * configured a Host and a daemon address, and ADR 0128 took those surfaces
 * away rather than leave controls with nothing behind them. Every tab writes
 * its record as it is answered — `settings.v1`, or the connector directory's
 * own — every tab is skippable, and "Skip all" takes the whole tour off the
 * table — skipping is recorded, so "looked and passed" stays distinct from
 * "never looked". The foot is icon keys for previous / skip / next, and the
 * shared `.go` Finish.
 *
 * Designed in `docs/design/first-run-setup/`.
 */

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
import { landFocus } from "../lib/focus.js";
import { loadSettings, signInMethods } from "../lib/settings.js";
import { completeSetup } from "../lib/setup.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { KeepIt } from "./setup/KeepIt.js";
import { AiStep } from "./setup/steps/AiStep.js";
import { ConnectorsStep } from "./setup/steps/ConnectorsStep.js";
import { IdentityStep } from "./setup/steps/IdentityStep.js";
import { MfaStep } from "./setup/steps/MfaStep.js";
import "./setup.css";

export const setupScreenDependencies = {
  completeSetup,
  loadSettings,
};

export type SetupRoad = "setup";

const STEPS = [
  {
    id: "connectors",
    tab: "connectors",
    rail: "Connectors",
    Panel: ConnectorsStep,
  },
  { id: "ai", tab: "ai", rail: "AI", Panel: AiStep },
  { id: "identity", tab: "identity", rail: "Identity", Panel: IdentityStep },
  { id: "mfa", tab: "mfa", rail: "MFA", Panel: MfaStep },
] as const;

/** A tab of the operator ceremony (ADR 0114). */
export type SetupStep = (typeof STEPS)[number]["id"];

export function SetupScreen({
  onDone,
  step,
}: {
  /** Back to the sign-in screen — after finishing, or by backing out. */
  onDone: () => void;
  /**
   * The tab to open on — a road that knows its concern (the no-way-in notice)
   * lands on it directly; anything else takes the tour from the top.
   */
  step?: SetupStep;
}) {
  useSupportRoute("/setup");
  const finishRef = useGuideTarget<HTMLButtonElement>("setup.finish");
  const [finishing, setFinishing] = useState(false);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      STEPS.findIndex((entry) => entry.id === step),
    ),
  );
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
          <current.Panel />

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
