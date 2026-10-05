/**
 * One default for every `expect(locator)` the verify scripts make.
 *
 * Playwright's own default is 5s. That is fine on a laptop and wrong on a
 * shared CI runner, where a page that has just been opened has to unlock a
 * vault and render before the assertion can see anything: the same journeys
 * already pass `{ timeout: 30_000 }` on their neighbouring steps, and the one
 * step that did not is the one that failed (`assertConsumedApplicationRequest`,
 * "element(s) not found" after 5000ms). Waiting longer costs a passing check
 * nothing, because an assertion returns the moment it holds; it only lets a
 * slow runner finish. A step that needs a different bound still passes its
 * own `timeout`. `PAGES_EXPECT_TIMEOUT_MS` shortens it for a local run.
 *
 * Imported for its effect, by the harness and by the entries that do not use it.
 */
import { expect } from "@playwright/test";

const fromEnv = Number(process.env.PAGES_EXPECT_TIMEOUT_MS);

export const EXPECT_TIMEOUT_MS =
  Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000;

expect.configure({ timeout: EXPECT_TIMEOUT_MS });
