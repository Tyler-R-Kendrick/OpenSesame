/**
 * `expect` with a timeout that a slow machine can meet. Playwright's library
 * default is five seconds, which a loaded runner misses without anything being
 * wrong; the journeys wait for conditions, so a long bound costs nothing when
 * the condition arrives and a failure still fails, only later.
 */
import { expect as base } from "@playwright/test";

export const expect = base.configure({ timeout: 30_000 });
