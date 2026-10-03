/**
 * `verify_login`: prove the new credential works by using it (ADR 0076 §9).
 *
 * A fresh login, never a probe of the old value, and never in the session the
 * change was made in: that session is signed in already, so a "login" there
 * proves only that the site remembers it. The runner opens a clean private
 * browsing context, signs in with the candidate, and reports what it saw.
 *
 * Three answers, and the third is the one that is easy to lose: `Works` when the
 * signed-in marker appears, `Rejected` when the site's refusal appears and the
 * marker does not, and `Indeterminate` for everything else — no profile to log
 * in with, no private context to do it in, a page that offered neither marker
 * (a second step, a challenge). Indeterminate is never read as either of the
 * others; the executor parks it for a person.
 */
import { type DriverDeps, ctxOf } from "./context";
import { withinOrigin } from "./origin";
import type { StepPages } from "./ports";
import { type RunnerStepOutcome, failed, verified } from "./wire";

export const LOGIN_WINDOW_MS = 20_000;
const SLICE_MS = 1_000;

async function outcomeOf(
  pages: StepPages,
  signedIn: string,
  rejected: string | undefined,
  windowMs: number,
): Promise<"Works" | "Rejected" | "Indeterminate"> {
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    if ((await pages.waitFor(signedIn, SLICE_MS)) === "ok") return "Works";
    if (rejected && (await pages.waitFor(rejected, 0)) === "ok")
      return "Rejected";
  }
  return "Indeterminate";
}

export async function verifyByFreshLogin(
  reference: string,
  d: DriverDeps,
): Promise<RunnerStepOutcome> {
  const ctx = ctxOf(d);
  const entry = await d.vault.getEntry(d.run.origin);
  const password = await d.vault.resolve(reference, ctx);
  if (password === null) return failed("transport");
  const profile = entry?.login;
  if (!entry || !profile || !withinOrigin(profile.url, d.run.origin)) {
    return verified("Indeterminate");
  }
  const clean = await d.pages.fresh();
  if (clean === null) return verified("Indeterminate");
  try {
    if ((await clean.navigate(profile.url)) !== "ok") {
      return verified("Indeterminate");
    }
    if ((await clean.waitFor(profile.passwordSelector)) !== "ok") {
      return verified("Indeterminate");
    }
    if (profile.usernameSelector) {
      const typed = await clean.fill(profile.usernameSelector, entry.username);
      if (typed !== "ok") return verified("Indeterminate");
    }
    if ((await clean.fill(profile.passwordSelector, password)) !== "ok") {
      return verified("Indeterminate");
    }
    if ((await clean.submit(profile.submitSelector)) !== "ok") {
      return verified("Indeterminate");
    }
    return verified(
      await outcomeOf(
        clean,
        profile.signedInSelector,
        profile.rejectedSelector,
        d.loginWindowMs ?? LOGIN_WINDOW_MS,
      ),
    );
  } finally {
    await clean.close().catch(() => undefined);
  }
}
