/** @vitest-environment jsdom */
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  render,
  renderHook,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { clearJoinDraft, joinDraft } from "./live-hooks.js";
import { useAsk } from "./live-join-ask-state.js";
import { LiveJoinAskForm } from "./live-join-route-parts.js";

const link: LiveLink = {
  admission: "open",
  owner: "A".repeat(87),
  secret: "A".repeat(43),
  routes: null,
};
const originalHooks = { ...vaultHooksSeams };

beforeEach(() => {
  clearJoinDraft();
  joinDraft.name = "  Alex  ";
});
afterEach(() => {
  cleanup();
  clearJoinDraft();
  Object.assign(vaultHooksSeams, originalHooks);
});

describe("the live join ask", () => {
  it("needs a name on an unlocked device", () => {
    const { result } = renderHook(() => useAsk(link, "unlocked"));
    expect(result.current.ready).toBe(true);
    expect(result.current.cleanedName).toBe("Alex");
    act(() => result.current.set.setName("   "));
    expect(result.current.ready).toBe(false);
    act(() => result.current.set.setName("Grace"));
    expect(result.current.ready).toBe(true);
  });

  it("creates a new sealed vault when the local vault is locked", () => {
    const { result } = renderHook(() => useAsk(link, "locked"));
    expect(result.current.ready).toBe(false);
    expect(result.current.sealProblem).toBe("Choose a PIN for your own vault.");
    act(() => {
      result.current.set.setPin("73926584");
      result.current.set.setConfirm("73926584");
      result.current.set.setAccepted(true);
    });
    expect(result.current.ready).toBe(true);
  });

  it("creates the joiner's own vault with a visible PIN policy", () => {
    const { result } = renderHook(() => useAsk(link, "empty"));
    expect(result.current.ready).toBe(false);
    expect(result.current.sealProblem).toBe("Choose a PIN for your own vault.");
    act(() => result.current.set.setPin("10060211"));
    expect(result.current.pinProblem).toBeTruthy();
    expect(result.current.ready).toBe(false);
    act(() => {
      result.current.set.setPin("73926584");
      result.current.set.setConfirm("73926584");
      result.current.set.setAccepted(true);
    });
    expect(result.current.pinProblem).toBeNull();
    expect(result.current.sealProblem).toBeNull();
    expect(result.current.ready).toBe(true);
  });

  it("asks only for an invite code on an invite link", () => {
    const { result, rerender } = renderHook(
      ({ held }: { held: LiveLink }) => useAsk(held, "unlocked"),
      { initialProps: { held: { ...link, admission: "invite" } } },
    );
    expect(result.current.needsCode).toBe(true);
    expect(result.current.ready).toBe(false);
    act(() => result.current.set.setCode("bcdf-ghjk"));
    expect(result.current.normalized).toBe("BCDF-GHJK");
    expect(result.current.ready).toBe(true);
    rerender({ held: { ...link, routes: "!" } });
    expect(result.current.link).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("draws the vault setup on a new device with a visible reason", () => {
    Object.assign(vaultHooksSeams, {
      useVault: () => ({
        ...vaultStore.getSnapshot(),
        status: "empty" as const,
      }),
    });
    const form = within(render(<LiveJoinAskForm held={link} />).container);
    expect(form.getAllByRole("textbox").map((field) => field.id)).toEqual([
      "live-name",
      "live-note",
    ]);
    expect(form.getByLabelText("Your vault PIN")).toBeTruthy();
    expect(form.getByLabelText("Confirm PIN")).toBeTruthy();
    expect(form.getByText("Choose a PIN for your own vault.")).toBeTruthy();
  });
});
