/**
 * The Keys panel on a real broker, in a real unlocked vault: what the panel and
 * sheet tests open, fill and hold. Only the vault hooks' clipboard and tomb are
 * stood in for. `localRequestFixture` freezes `Date.now`, so a test says when a
 * later moment is by moving it.
 */
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { bindModelKeyBroker } from "@opensesame/app-core/lib/model-keys/active.js";
import { harness } from "@opensesame/app-core/lib/model-keys/harness.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import {
  type RenderResult,
  cleanup,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { vaultHooksSeams } from "../../../../lib/vault/hooks.js";
import { ModelKeysPanel } from "./ModelKeysPanel.js";

export type KeyHarness = ReturnType<typeof harness>;

/** Longer than the sheet's guard against the press that made a key landing on Done. */
const PAST_THE_GUARD_MS = 1000;

/** Hold the broker's next key at its hash, until the returned release is called. */
export function holdMint(h: KeyHarness): () => void {
  let release = () => {};
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.gate.holdOn = h.gate.calls + 1;
  return () => release();
}

/** Register the vault seams and the teardown for the tests of this file. */
export function mintKeyTestBed() {
  const original = { ...vaultHooksSeams };
  const vault = { tomb: "" };
  const releases: (() => void)[] = [];
  let view: RenderResult | null = null;

  beforeEach(() => {
    vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
    vi.stubGlobal(
      "ArrayBuffer",
      new TextEncoder().encode("").buffer.constructor,
    );
    // user-event walks a radio group by a selector it escapes with the browser's `CSS.escape`.
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ ...vaultStore.getSnapshot(), tomb: vault.tomb }),
      useCopySecret: () => async () => "copied" as const,
    });
  });
  afterEach(() => {
    Object.assign(vaultHooksSeams, original);
    cleanup();
    view = null;
    for (const release of releases.splice(0)) release();
    lockAllTombs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function ready(providerId = "openai", connectionId = "conn-openai") {
    vault.tomb = (await localRequestFixture()).tomb;
    const h = harness({ senderConstraint: "dpop_optional" });
    releases.push(bindModelKeyBroker(h.broker));
    view = render(
      <ModelKeysPanel
        providerId={providerId}
        providerName="OpenAI"
        connectionId={connectionId}
      />,
    );
    return h;
  }

  /** The page lets go of the panel, as a lock or a navigation does. */
  function unmount() {
    view?.unmount();
  }

  /** Let the guard on Done pass, as it does for a person who has read the key. */
  function afterTheGuard() {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + PAST_THE_GUARD_MS);
  }

  return { ready, unmount, afterTheGuard };
}

/** Open the sheet and type a name and a list of models; the Create key is returned as a getter. */
export async function fillSheet(client: string, models: string) {
  await userEvent.click(screen.getByRole("button", { name: "Create a key" }));
  const sheet = screen.getByRole("dialog", { name: "Create a key" });
  const create = () =>
    within(sheet).getByRole("button", { name: "Create a key" });
  expect(create()).toHaveProperty("disabled", true);
  await userEvent.type(within(sheet).getByLabelText("App or agent"), client);
  await userEvent.type(within(sheet).getByLabelText("Models"), models);
  return { sheet, create };
}
