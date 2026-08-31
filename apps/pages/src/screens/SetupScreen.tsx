/**
 * The first-run setup ceremony.
 *
 * What this replaces: a block of amber above the unlock form, reporting that
 * the deployment had no identity service and offering a text field for an
 * address the reader had never been given — above sign-in options that could
 * not work and an Unlock tab for a vault that did not exist. It was an
 * accurate report of a state nobody had been asked to resolve.
 *
 * The first person to open a fresh deployment is the only one who can resolve
 * it, so they are treated as its operator and asked. Four questions, one per
 * screen, every one of them skippable and every skip stated in what it costs:
 * a local-only vault is a legitimate answer to setup, not a failure of it.
 *
 * The shape is the app's own ceremony vocabulary (`CeremonyShell`,
 * `FieldShell`, the found card and its expand-in-place alternatives), with one
 * addition that is the whole of the mobile fix: **the commitment lives at the
 * bottom of the phone, in the same place on every step.** Nothing in the
 * ceremony navigates — the pairing step mounts the real pairing ceremony
 * rather than sending anyone to Settings.
 *
 * Designed in `docs/design/first-run-setup/`.
 */

import { useState } from "react";
import { IconChevronLeft, IconMark } from "../components/Icons.js";
import { loadSettings } from "../lib/settings.js";
import {
  SETUP_STEPS,
  type SetupStep,
  completeSetup,
  initialStep,
} from "../lib/setup.js";
import { HostStep } from "./setup/HostStep.js";
import { IdentityStep } from "./setup/IdentityStep.js";
import { MachineStep } from "./setup/MachineStep.js";
import { ReviewStep } from "./setup/ReviewStep.js";
import "./setup.css";

const STEP_LABEL = {
  identity: "Identity",
  host: "Host",
  machine: "Machine",
  review: "Review",
} satisfies Record<SetupStep, string>;

const STEP_TITLE = {
  identity: "Where does identity live?",
  host: "Is there a Host?",
  machine: "Pair this machine",
  review: "Ready",
} satisfies Record<SetupStep, string>;

const STEP_LEAD = {
  identity:
    "You are the first person here, so you are the operator. Point this app at the services it should use — every answer is optional.",
  host: "The authority plane. It authorizes every ConnectionRef and signs every receipt. A vault without one still holds your own items.",
  machine:
    "A daemon on your tailnet fronts the Host and Identity APIs, so this page can reach them from wherever you are signed in.",
  review:
    "This is what gets written. Nothing has left this device — these are addresses, not credentials.",
} satisfies Record<SetupStep, string>;

const STEP_SKIP = {
  identity: "Skip identity",
  host: "No Host",
  machine: "Not now",
  review: "Start over",
} satisfies Record<SetupStep, string>;

export const setupScreenDependencies = {
  loadSettings,
  completeSetup,
  initialStep,
};

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<SetupStep>(() =>
    setupScreenDependencies.initialStep(),
  );
  const [provider, setProvider] = useState("");
  const [finishing, setFinishing] = useState(false);
  // Bumped when a step writes settings, so Review re-reads them on arrival
  // rather than showing what `loadSettings()` said when the screen mounted.
  const [revision, setRevision] = useState(0);

  const index = SETUP_STEPS.indexOf(step);
  const last = index === SETUP_STEPS.length - 1;

  function goto(next: SetupStep) {
    setRevision((value) => value + 1);
    setStep(next);
  }

  function advance() {
    if (!last) {
      goto(SETUP_STEPS[index + 1] ?? "review");
      return;
    }
    const settings = setupScreenDependencies.loadSettings();
    setFinishing(true);
    void setupScreenDependencies
      .completeSetup({
        identity: settings.identityApi.trim() ? "connected" : "local-only",
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
              onClick={() => goto(id)}
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

          {step === "identity" ? (
            <IdentityStep provider={provider} onProviderChange={setProvider} />
          ) : null}
          {step === "host" ? (
            <HostStep onPairInstead={() => goto("machine")} />
          ) : null}
          {step === "machine" ? (
            <MachineStep onPaired={() => goto("review")} />
          ) : null}
          {step === "review" ? (
            <ReviewStep key={revision} provider={provider} />
          ) : null}
        </main>

        <div className="setup__foot">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous step"
            disabled={index === 0}
            onClick={() => goto(SETUP_STEPS[index - 1] ?? "identity")}
          >
            <IconChevronLeft size={20} />
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={finishing}
            aria-busy={finishing}
            onClick={advance}
          >
            {last ? (finishing ? "Saving…" : "Finish setup") : "Continue"}
          </button>
          <button
            type="button"
            className="setup__skip"
            disabled={finishing}
            onClick={() =>
              goto(last ? "identity" : (SETUP_STEPS[index + 1] ?? "review"))
            }
          >
            {STEP_SKIP[step]}
          </button>
        </div>
      </div>
    </div>
  );
}
