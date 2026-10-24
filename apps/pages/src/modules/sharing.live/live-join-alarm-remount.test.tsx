/** @vitest-environment jsdom */
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { clearJoinDraft, joinDraft, liveUiSeams } from "./live-hooks.js";
import { LiveJoinAskForm } from "./live-join-route-parts.js";
import type { JoinTrustFields } from "./live-join-trust.js";

const CHANGED = "This peer's key changed";
const BLOCKED: JoinTrustFields = {
  blocked: CHANGED,
  peerTrustSignal: "signal",
  unverifiedManual: false,
};
const link: LiveLink = {
  admission: "open",
  owner: "A".repeat(87),
  secret: "A".repeat(43),
  routes: null,
};
const originalHooks = { ...vaultHooksSeams };
const originalTrust = liveUiSeams.joinTrust;

/**
 * The remembered-key check, held open so the form can mount again before it
 * answers, as it does when the first ask creates the joiner's vault.
 */
type HeldTrustCheck = {
  checks: string[];
  answer: (fields: JoinTrustFields) => void;
};
const trust: HeldTrustCheck = { checks: [], answer: () => {} };

beforeEach(() => {
  clearJoinDraft();
  joinDraft.name = "Casey";
  joinDraft.peerTrust = "signal";
  trust.checks = [];
  liveUiSeams.joinTrust = (signal) => {
    trust.checks.push(signal);
    return new Promise<JoinTrustFields>((resolve) => {
      trust.answer = resolve;
    });
  };
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
    }),
  });
});
afterEach(() => {
  cleanup();
  clearJoinDraft();
  liveUiSeams.joinTrust = originalTrust;
  Object.assign(vaultHooksSeams, originalHooks);
});

function askKey(form: ReturnType<typeof within>) {
  return form.getByRole("button", { name: /^Ask to join/ });
}

/** Ask, mount the form again mid-ask, and let the check refuse the key. */
async function refusedAcrossRemount() {
  const view = render(<LiveJoinAskForm key="before" held={link} />);
  fireEvent.click(askKey(within(view.container)));
  view.rerender(<LiveJoinAskForm key="after" held={link} />);
  await act(async () => trust.answer(BLOCKED));
  return within(view.container);
}

it("keeps a changed key's mark and held Ask key on the form that mounts again", async () => {
  const form = await refusedAcrossRemount();
  expect(form.getByRole("img", { name: CHANGED })).toBeTruthy();
  expect(askKey(form).hasAttribute("disabled")).toBe(true);
  expect(trust.checks).toEqual(["signal"]);
});

it("lets a new signal clear the mark, and the next ask checks the key again", async () => {
  const form = await refusedAcrossRemount();
  fireEvent.change(form.getByLabelText("Peer trust signal"), {
    target: { value: "another signal" },
  });
  expect(form.queryByRole("img", { name: CHANGED })).toBeNull();
  fireEvent.click(askKey(form));
  expect(trust.checks).toEqual(["signal", "another signal"]);
});
