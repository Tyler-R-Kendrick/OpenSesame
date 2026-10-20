/** @vitest-environment jsdom */
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
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
  it("requires a device seal in order, without losing the in-memory draft", () => {
    const { result, rerender } = renderHook(
      (status: "empty" | "locked" | "unlocked") => useAsk(link, status),
      { initialProps: "empty" },
    );
    expect(result.current.sealProblem).toBe(
      "Choose a device PIN to seal your vault.",
    );
    expect(result.current.ready).toBe(false);
    act(() => result.current.set.setPin("73926584"));
    expect(result.current.sealProblem).toBe("Confirm the device PIN.");
    act(() => result.current.set.setConfirm("84652937"));
    expect(result.current.pinProblem).toBe("PINs do not match.");
    expect(result.current.sealProblem).toBe("PINs do not match.");
    act(() => result.current.set.setConfirm("73926584"));
    expect(result.current.sealProblem).toBe(
      "Acknowledge that the vault cannot be recovered.",
    );
    act(() => result.current.set.setAccepted(true));
    expect(result.current.ready).toBe(true);
    rerender("locked");
    expect(result.current.sealProblem).toBe(
      "Unlock this device before joining.",
    );
    expect(result.current.ready).toBe(false);
    rerender("unlocked");
    expect(result.current.sealProblem).toBeNull();
    expect(result.current.ready).toBe(true);
    expect(result.current.cleanedName).toBe("Alex");
  });

  it("keeps PIN policy ahead of confirmation and acknowledgement", () => {
    const { result } = renderHook(() => useAsk(link, "empty"));
    act(() => {
      result.current.set.setPin("11111111");
      result.current.set.setConfirm("22222222");
      result.current.set.setAccepted(true);
    });
    expect(result.current.pinProblem).toBeTruthy();
    expect(result.current.pinProblem).not.toBe("PINs do not match.");
    expect(result.current.sealProblem).toBe(result.current.pinProblem);
    expect(result.current.ready).toBe(false);
  });

  it("requires an invite code and rejects malformed routes before asking", () => {
    const { result, rerender } = renderHook(
      (held: LiveLink) => useAsk(held, "unlocked"),
      { initialProps: { ...link, admission: "invite" } },
    );
    expect(result.current.needsCode).toBe(true);
    expect(result.current.ready).toBe(false);
    act(() => result.current.set.setCode("bcdf-ghjk"));
    expect(result.current.normalized).toBe("BCDF-GHJK");
    expect(result.current.ready).toBe(true);
    rerender({ ...link, routes: "!" });
    expect(result.current.link).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("stops before owner setup when device sealing fails and settles the ask", async () => {
    const calls: string[] = [];
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({
        ...vaultStore,
        createWithPin: async (pin: string) => {
          calls.push(`seal:${pin}`);
          throw new Error("device storage refused");
        },
        activeTomb: () => {
          calls.push("owner");
          return null;
        },
      }),
    });
    const { result } = renderHook(() => useAsk(link, "empty"));
    act(() => {
      result.current.set.setPin("73926584");
      result.current.set.setConfirm("73926584");
      result.current.set.setAccepted(true);
    });
    await act(() => result.current.ask());
    expect(calls).toEqual(["seal:73926584"]);
    expect(result.current.busy).toBe(false);
    expect(result.current.failed).toBe(
      "This browser could not make a request code",
    );
  });

  it("preserves the rendered field order and seal refusal on the submit control", () => {
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
    expect(
      form.getByRole("button", {
        name: "Ask to join. Choose a device PIN to seal your vault.",
      }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(form.getByLabelText("Device PIN"), {
      target: { value: "73926584" },
    });
    fireEvent.change(form.getByLabelText("Confirm PIN"), {
      target: { value: "73926584" },
    });
    fireEvent.click(
      form.getByRole("checkbox", {
        name: "I understand this vault cannot be recovered.",
      }),
    );
    expect(form.getByRole("button", { name: "Ask to join" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(
      Array.from(
        form
          .getByLabelText("Your name")
          .closest("form")
          ?.querySelectorAll("input") ?? [],
        (field) => field.id,
      ),
    ).toEqual([
      "live-name",
      "live-note",
      "live-device-pin",
      "live-device-pin-confirm",
      "",
      "live-peer-trust",
    ]);
  });
});
