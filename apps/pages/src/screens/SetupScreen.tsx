/**
 * The first-run setup ceremony.
 *
 * What this replaces: a block of amber above the unlock form, reporting that
 * the deployment had no identity service and offering a text field for an
 * address the reader had never been given — above sign-in options that could
 * not work and an Unlock tab for a vault that did not exist.
 *
 * And then, briefly, something not much better: four steps that led with an
 * OpenSesame identity service URL, a Host URL and a daemon on the operator's
 * own machine. That had the dependency backwards. `TRUSTED_UPSTREAMS` compiles
 * a browser-capable upstream into every build, so **sign-in already works on a
 * deployment nobody has configured** — and the ceremony was making everyone
 * walk past three self-hosted fields to reach it.
 *
 * So it is two steps. The first asks the only question with a wrong answer —
 * how do people sign in — with the zero-config road selected by default and
 * the identity service asked for only on the road that needs one. The second
 * is optional, closed, and holds the infrastructure an operator who has it
 * needs somewhere to name.
 *
 * The commitment lives at the bottom of the phone, in the same place on both
 * steps, as the shared `.go` control: an ink square carrying the glyph of what
 * it does, its sentence beside it. Never a wide text button — see
 * `docs/design/controls.md`.
 *
 * Designed in `docs/design/first-run-setup/`.
 */

import { useState } from "react";
import {
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconMark,
} from "../components/Icons.js";
import { loadSettings } from "../lib/settings.js";
import {
  SETUP_STEPS,
  type SetupIdentityChoice,
  type SetupStep,
  completeSetup,
} from "../lib/setup.js";
import { MoreStep } from "./setup/MoreStep.js";
import { SignInStep } from "./setup/SignInStep.js";
import "./setup.css";

const STEP_LABEL = {
  signin: "Sign-in",
  more: "Everything else",
} satisfies Record<SetupStep, string>;

const STEP_TITLE = {
  signin: "How do people sign in?",
  more: "Anything else?",
} satisfies Record<SetupStep, string>;

const STEP_LEAD = {
  signin:
    "You are the first person here, so you are the operator. This is the one question that matters — and it already has a working answer.",
  more: "All optional, and all of it changeable later. Open a row only if you run that thing yourself.",
} satisfies Record<SetupStep, string>;

export const setupScreenDependencies = {
  loadSettings,
  completeSetup,
};

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<SetupStep>("signin");
  // The zero-config road is the default, because it is the one that already
  // works. Nobody has to choose it to get a usable app.
  const [choice, setChoice] = useState<SetupIdentityChoice>("brokered");
  const [provider, setProvider] = useState("");
  const [finishing, setFinishing] = useState(false);

  const index = SETUP_STEPS.indexOf(step);
  const last = index === SETUP_STEPS.length - 1;
  const verb = finishing ? "Saving…" : last ? "Finish setup" : "Continue";

  function advance() {
    if (!last) {
      setStep(SETUP_STEPS[index + 1] ?? "more");
      return;
    }
    const settings = setupScreenDependencies.loadSettings();
    setFinishing(true);
    void setupScreenDependencies
      .completeSetup({
        identity: choice,
        provider,
        host: Boolean(settings.hostApi.trim()),
        machine: Boolean(settings.daemonApi.trim()),
      })
      .catch(() => {
        // The record is a convenience, not a gate: a browser that cannot
        // persist it will ask again next time, which the unlock screen already
        // warns about. Never trap the operator on the last step for it.
      })
      .finally(onDone);
  }

  return (
    <div className="setup">
      <div className="setup__frame">
        <div className="setup__bar">
          <p className="setup__wordmark">
            <IconMark size={16} />
            opensesame
          </p>
          <span className="setup__count">
            {index + 1} / {SETUP_STEPS.length}
          </span>
        </div>

        <nav className="setup__rail" aria-label="Setup steps">
          {SETUP_STEPS.map((id, position) => (
            <button
              key={id}
              type="button"
              className={
                position < index
                  ? "setup__seg is-done"
                  : position === index
                    ? "setup__seg is-now"
                    : "setup__seg"
              }
              aria-current={position === index ? "step" : undefined}
              onClick={() => setStep(id)}
            >
              <span className="setup__seg-bar" aria-hidden="true" />
              <span className="setup__seg-label">{STEP_LABEL[id]}</span>
            </button>
          ))}
        </nav>

        <main className="setup__body" id="main">
          <div className="setup__head">
            <h1>{STEP_TITLE[step]}</h1>
            <p>{STEP_LEAD[step]}</p>
          </div>

          {step === "signin" ? (
            <SignInStep
              choice={choice}
              onChoiceChange={setChoice}
              provider={provider}
              onProviderChange={setProvider}
            />
          ) : (
            <MoreStep choice={choice} provider={provider} />
          )}
        </main>

        {/* The terminal commit: an ink square with the glyph of what it does,
            its sentence beside it. `docs/design/controls.md`. */}
        <div className="setup__foot">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous step"
            disabled={index === 0}
            onClick={() => setStep(SETUP_STEPS[index - 1] ?? "signin")}
          >
            <IconChevronLeft size={20} />
          </button>
          <div className="go-row">
            <button
              type="button"
              className="go"
              disabled={finishing}
              aria-busy={finishing}
              aria-label={verb}
              title={verb}
              onClick={advance}
            >
              {last ? <IconCheck size={18} /> : <IconArrowRight size={18} />}
            </button>
            <span className="go-verb" aria-hidden="true">
              {verb}
            </span>
          </div>
          {last ? null : (
            <button
              type="button"
              className="setup__skip"
              onClick={() => setStep("more")}
            >
              Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
