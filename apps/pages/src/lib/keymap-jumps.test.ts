/** @vitest-environment jsdom */
/**
 * A contributed `g` jump is authorized when it is pressed (ownership.md
 * §4.2): `g p` moves only while the capability that registered `p` is
 * approved under a current lease, and is swallowed — no move, no fallback
 * to another binding — once it is not. Driven through the real keydown
 * handler and the real registry, not an injected entry.
 */

import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import { deriveLease } from "@opensesame/app-core/lib/capabilities/lease.js";
import {
  bindLeaseToCapability,
  registerContribution,
} from "@opensesame/app-core/lib/capabilities/registry.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sectionJumpPath } from "./keymap-jumps.js";
import { createKeymapHandler } from "./keymap.js";

const PASSKEYS = "vault.passkey-records";

async function registerJump(): Promise<void> {
  await bootPersonalLocal();
  const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
  await compositionStore.commit(draft, receipt);
  const child = deriveLease(compositionStore.currentLease());
  bindLeaseToCapability(child.lease, PASSKEYS);
  registerContribution(
    "keymap-jump",
    { key: "p", path: "/passkeys" },
    child.lease,
  );
}

function chord(navigate: (path: string) => void): KeyboardEvent {
  const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
  handler(new KeyboardEvent("keydown", { key: "g", cancelable: true }));
  const second = new KeyboardEvent("keydown", { key: "p", cancelable: true });
  handler(second);
  return second;
}

beforeEach(freshRealm);
afterEach(() => {
  document.body.replaceChildren();
});

describe("contributed section jumps", () => {
  it("move while the registering capability is approved", async () => {
    await registerJump();
    expect(sectionJumpPath("p")).toBe("/passkeys");
    const navigate = vi.fn();
    chord(navigate);
    expect(navigate).toHaveBeenCalledWith("/passkeys");
  });

  it("are swallowed, not followed, once the capability is disabled", async () => {
    await registerJump();
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(sectionJumpPath("p")).toBeNull();
    const navigate = vi.fn();
    const event = chord(navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("are refused once the realm is locked", async () => {
    await registerJump();
    compositionStore.invalidate("vault-lock");
    const navigate = vi.fn();
    chord(navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leave the core jumps alone", async () => {
    await bootPersonalLocal();
    expect(sectionJumpPath("v")).toBe("/vault");
    expect(sectionJumpPath("s")).toBe("/settings");
  });
});
