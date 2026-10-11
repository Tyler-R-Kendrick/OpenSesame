/**
 * Starting points the test files of this folder share: a harness with a root
 * key already issued, and the narrowing details of an exchange. Each is a
 * fixture, not a rule; a test that needs something else builds its own from
 * `harness()`.
 */
import type { JsonObject } from "@opensesame/os-domain";
import {
  FULL_BUDGET,
  OPENAI,
  harness,
  newSigner,
} from "./harness.test-support.js";

/** A harness, the signer a root key is bound to, and the root key itself. */
export async function ready(overrides = {}) {
  const h = harness();
  const signer = await newSigner();
  const root = await h.root(signer, overrides);
  return { h, signer, root, token: root.token };
}

/** A request to narrow to one model and one action, for ten minutes. */
export const narrow = (extra: JsonObject = {}) => ({
  locations: [OPENAI.baseUrl],
  models: ["gpt-4o"],
  actions: ["model.invoke"],
  budget: FULL_BUDGET,
  lifetime_seconds: 600,
  ...extra,
});

/** The same request with no lifetime of its own, so the broker picks one. */
export const detail = (extra: JsonObject = {}) => ({
  locations: [OPENAI.baseUrl],
  models: ["gpt-4o"],
  actions: ["model.invoke"],
  budget: FULL_BUDGET,
  ...extra,
});
