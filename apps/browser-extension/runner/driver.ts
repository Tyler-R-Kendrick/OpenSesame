/**
 * One step, executed: the verb in the page, or the custody step in the vault.
 *
 * This is the controller of ADR 0076 §1 on the far side of the step channel.
 * The Host says *which* credential and *where*; this resolves the reference
 * and writes the value, and what it answers is a verdict about the page — a
 * `filled`, a `presence`, a `verified`, markup with the values stripped — never
 * the value. Every answer is built by `wire.ts`'s closed constructors and
 * checked by `guard` against the step it answers before it leaves.
 */
import type { RunnerStepRequest } from "@opensesame/api-client";
import { WAIT_MS, ctxOf } from "./context";
import type { DriverDeps, EpochState } from "./context";
import { withinOrigin } from "./origin";
import type { StepPages } from "./ports";
import { verifyByFreshLogin } from "./verify";
import {
  type RunnerStepOutcome,
  dom,
  done,
  failed,
  filled,
  frame,
  guard,
  presence,
  redactKnown,
  sealed,
} from "./wire";

function moved(epoch: EpochState): void {
  epoch.epoch += 1;
  epoch.layout = null;
}

/** Whether the layout changed since the last read; advances the epoch if so. */
async function settleEpoch(pages: StepPages, epoch: EpochState): Promise<void> {
  const now = await pages.layout();
  if (epoch.layout !== null && epoch.layout !== now) epoch.epoch += 1;
  epoch.layout = now;
}

async function navigate(
  url: string,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  // Checked before the browser is touched: a step cannot take the runner off
  // the origin it was armed for.
  if (!withinOrigin(url, d.run.origin)) return failed("navigation");
  const landed = await d.pages.navigate(url);
  if (landed === "timeout") return failed("timeout");
  if (landed === "navigation") return failed("navigation");
  moved(d.epoch);
  return done();
}

async function waitFor(
  selector: string,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const landed = await d.pages.waitFor(selector, d.waitMs ?? WAIT_MS);
  if (landed === "ok") return done();
  return failed(landed === "timeout" ? "timeout" : "no_such_element");
}

async function fill(
  reference: string,
  selector: string,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const value = await d.vault.resolve(reference, ctxOf(d));
  if (value === null) return failed("transport");
  const landed = await d.pages.fill(selector, value);
  moved(d.epoch);
  return filled(landed === "ok");
}

async function assertPresent(
  reference: string,
  selector: string,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const expected = await d.vault.resolve(reference, ctxOf(d));
  if (expected === null) return failed("transport");
  const state = await d.pages.presence(selector, expected);
  if (state === "invalid") return failed("no_such_element");
  const names = {
    present: "Present",
    absent: "Absent",
    mismatch: "Mismatch",
  } as const;
  return presence(names[state]);
}

async function submit(
  selector: string,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const pressed = await d.pages.submit(selector);
  moved(d.epoch);
  return pressed === "ok" ? done() : failed("no_such_element");
}

async function readDom(
  strip: string[],
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const known = await d.vault.secrets(ctxOf(d));
  const text = redactKnown(await d.pages.readDom(strip), known);
  await settleEpoch(d.pages, d.epoch);
  return dom(text, d.epoch.epoch);
}

async function screenshot(
  maskSelectors: string[],
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  await settleEpoch(d.pages, d.epoch);
  const taken = await d.pages.capture(maskSelectors);
  if (taken === null) return failed("transport");
  // The mask was composited under one layout. If the page moved between the
  // mask and the still, the epoch advances past the one the Host asked for and
  // the Host drops the frame, rather than vouching for covers that may be
  // misplaced. The epoch is reported as it stands, never as it was requested.
  if (taken.before !== taken.after) moved(d.epoch);
  return frame(taken.image, d.epoch.epoch, taken.covered);
}

async function custody(
  request: Extract<
    RunnerStepRequest,
    { step: "generate_candidate" | "seal_candidate" | "promote_candidate" }
  >,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const ctx = ctxOf(d);
  if (request.step === "generate_candidate") {
    return (await d.vault.generate(ctx, request.handle))
      ? done()
      : failed("transport");
  }
  if (request.step === "seal_candidate") {
    // Fail closed: anything but a proven backup is the answer that stops the run.
    return sealed(
      await d.vault.seal(ctx, request.handle, d.backup).catch(() => false),
    );
  }
  return (await d.vault.promote(ctx, request.handle))
    ? done()
    : failed("transport");
}

async function execute(
  request: RunnerStepRequest,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  switch (request.step) {
    case "navigate":
      return navigate(request.url, d);
    case "wait_for":
      return waitFor(request.selector, d);
    case "fill_credential":
      return fill(request.reference, request.selector, d);
    case "assert_present":
      return assertPresent(request.reference, request.selector, d);
    case "submit":
      return submit(request.selector, d);
    case "read_dom_redacted":
      return readDom(request.strip, d);
    case "screenshot_redacted":
      return screenshot(request.mask_selectors, d);
    case "verify_login":
      return verifyByFreshLogin(request.reference, d);
    case "generate_candidate":
    case "seal_candidate":
    case "promote_candidate":
      return custody(request, d);
    // A ceremony capture seals to a recipient the Host defines, and no scheme
    // for that envelope exists to seal to. Refused as a failure rather than
    // answered with something that merely looks sealed.
    case "capture_credential":
    case "capture_download":
      return failed("transport");
    default:
      return failed("transport");
  }
}

/**
 * Execute `request` and return what to settle. Never throws: a step that
 * cannot be carried out is a `failed` outcome, which is a verdict the Host
 * knows how to read, and an unreadable answer is never sent in its place.
 */
export async function runStep(
  request: RunnerStepRequest,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  let outcome: RunnerStepOutcome;
  try {
    outcome = await execute(request, d);
  } catch {
    outcome = failed("transport");
  }
  const known = await d.vault.secrets(ctxOf(d)).catch(() => []);
  return guard(request.step, outcome, known);
}
