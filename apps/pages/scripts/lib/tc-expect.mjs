/**
 * `expect` under the gate's one timeout. `expect-timeout.mjs` sets Playwright's
 * default for the scripts that import it; the matchers the Trusted contacts
 * gate calls are this configured copy, so a slow runner and a short local run
 * (`PAGES_EXPECT_TIMEOUT_MS`) both reach every assertion.
 */

import { expect as base } from "@playwright/test";
import { EXPECT_TIMEOUT_MS } from "./expect-timeout.mjs";

export const expect = base.configure({ timeout: EXPECT_TIMEOUT_MS });
