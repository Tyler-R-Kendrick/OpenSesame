import { createItem } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import type { RotationEvent } from "../vault/rotation-queue.js";
import {
  dispatchPasswordResetRotation,
  passwordResetHandOffSeams,
} from "./rotation-handoff.js";
import {
  clearVaultResetRunsForTest,
  setVaultResetRunPhase,
  vaultResetRunFor,
} from "./vault-run-tracker.js";

const event: RotationEvent = {
  id: "e1",
  scope: "personal",
  itemId: "item-1",
  typeId: "account",
  reason: "manual",
  queuedAt: "2026-10-27T00:00:00.000Z",
  dueAt: "2026-10-27T00:00:00.000Z",
  state: "queued",
  detail: null,
};

describe("dispatchPasswordResetRotation", () => {
  it("marks needs-you when the hand-off is refused", async () => {
    clearVaultResetRunsForTest();
    passwordResetHandOffSeams.handOff = vi.fn(async () => false);
    const item = createItem("account", "Mail");
    item.id = "item-1";
    item.uris = [
      { id: "u1", uri: "https://mail.example.test", match: "domain" },
    ];
    const result = await dispatchPasswordResetRotation(event, item);
    expect(result.ok).toBe(false);
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("needs-you");
    passwordResetHandOffSeams.handOff = null;
  });

  it("refuses a second dispatch while in progress", async () => {
    clearVaultResetRunsForTest();
    passwordResetHandOffSeams.handOff = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), 50);
        }),
    );
    const item = createItem("account", "Mail");
    item.id = "item-1";
    item.uris = [
      { id: "u1", uri: "https://mail.example.test", match: "domain" },
    ];
    const first = dispatchPasswordResetRotation(event, item);
    const second = await dispatchPasswordResetRotation(event, item);
    expect(second.ok).toBe(false);
    await first;
    passwordResetHandOffSeams.handOff = null;
  });

  it("refuses another dispatch while an accepted run needs takeover", async () => {
    clearVaultResetRunsForTest();
    setVaultResetRunPhase(
      "personal",
      "item-1",
      "needs-you",
      "captcha",
      new Date(),
      "job-7",
    );
    const handOff = vi.fn(async () => true);
    passwordResetHandOffSeams.handOff = handOff;
    const item = createItem("account", "Mail");
    item.id = "item-1";
    item.uris = [
      { id: "u1", uri: "https://mail.example.test", match: "domain" },
    ];
    expect((await dispatchPasswordResetRotation(event, item)).ok).toBe(false);
    expect(handOff).not.toHaveBeenCalled();
    expect(vaultResetRunFor("personal", "item-1")?.runId).toBe("job-7");
    passwordResetHandOffSeams.handOff = null;
  });

  it("clears the failed job ID while a retry is pending", async () => {
    clearVaultResetRunsForTest();
    setVaultResetRunPhase(
      "personal",
      "item-1",
      "failed",
      "failed",
      new Date(),
      "job-old",
    );
    let accept!: (result: { accepted: boolean; jobId: string }) => void;
    passwordResetHandOffSeams.handOff = vi.fn(
      () =>
        new Promise<{ accepted: boolean; jobId: string }>((resolve) => {
          accept = resolve;
        }),
    );
    const item = createItem("account", "Mail");
    item.id = "item-1";
    item.uris = [
      { id: "u1", uri: "https://mail.example.test", match: "domain" },
    ];
    const retry = dispatchPasswordResetRotation(event, item);
    expect(vaultResetRunFor("personal", "item-1")).toMatchObject({
      phase: "in-progress",
      runId: null,
    });
    accept({ accepted: true, jobId: "job-new" });
    expect((await retry).ok).toBe(true);
    expect(vaultResetRunFor("personal", "item-1")?.runId).toBe("job-new");
    passwordResetHandOffSeams.handOff = null;
  });

  it("stays in-progress with the job id when the hand-off accepts", async () => {
    clearVaultResetRunsForTest();
    passwordResetHandOffSeams.handOff = vi.fn(async () => ({
      accepted: true,
      jobId: "job-7",
    }));
    const item = createItem("account", "Mail");
    item.id = "item-1";
    item.uris = [
      { id: "u1", uri: "https://mail.example.test", match: "domain" },
    ];
    const result = await dispatchPasswordResetRotation(event, item);
    expect(result).toEqual({ ok: true });
    const run = vaultResetRunFor("personal", "item-1");
    expect(run?.phase).toBe("in-progress");
    expect(run?.runId).toBe("job-7");
    passwordResetHandOffSeams.handOff = null;
  });
});
