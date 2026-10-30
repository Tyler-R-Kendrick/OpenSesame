import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { passwordResetHandOffSeams } from "@opensesame/app-core/lib/password-reset/rotation-handoff.js";
import {
  clearVaultResetRunsForTest,
  setVaultResetRunPhase,
  vaultResetRunFor,
} from "@opensesame/app-core/lib/password-reset/vault-run-tracker.js";
import { expect, it, vi } from "vitest";
import {
  createHostResetRunNoticeBridge,
  installPasswordResetRotationRelay,
} from "./rotation-relay.js";

it("validates Host rotation receipts while preserving accepted and failed responses", async () => {
  const fetch = vi
    .spyOn(identitySeams, "hostFetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "job-1", status: "queued" }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 19 }), { status: 200 }),
    )
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  const restore = installPasswordResetRotationRelay({
    readiness: async () => ({ ok: true }),
  });
  try {
    const handOff = passwordResetHandOffSeams.handOff;
    if (!handOff) throw new Error("Missing installed handoff");
    await expect(handOff("https://provider.example")).resolves.toEqual({
      accepted: true,
      jobId: "job-1",
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/rotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web_login_origin: "https://provider.example",
        execute_now: true,
      }),
    });
    await expect(handOff("https://provider.example")).resolves.toEqual({
      accepted: true,
      jobId: null,
    });
    await expect(handOff("https://provider.example")).resolves.toEqual({
      accepted: false,
      jobId: null,
    });
  } finally {
    restore();
    fetch.mockRestore();
  }
});

it("handles real run-list shapes and ignores malformed entries before updating notices", async () => {
  clearVaultResetRunsForTest();
  clearNotices();
  setVaultResetRunPhase(
    "personal",
    "item-1",
    "in-progress",
    null,
    new Date(),
    "job-1",
  );
  const fetch = vi
    .spyOn(identitySeams, "hostFetch")
    .mockImplementation(async (path) => {
      if (path === "/api/v1/agent/runs")
        return new Response(
          JSON.stringify({
            runs: [
              { id: 9, job_id: "job-1", control_state: "awaiting_human" },
              {
                id: "run-9",
                job_id: "job-1",
                control_state: "awaiting_human",
                blocked_reason: "captcha",
                closed_at: null,
              },
            ],
            secrets_returned: false,
          }),
        );
      return new Response(JSON.stringify({ id: "job-1", status: "requested" }));
    });
  const controller = new AbortController();
  try {
    createHostResetRunNoticeBridge().start(controller.signal);
    await vi.waitFor(() => {
      expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("needs-you");
      expect(
        listNotices().find((notice) => notice.id === "agent-run:job-1")?.open
          ?.to,
      ).toBe("/runs/run-9");
    });
  } finally {
    controller.abort();
    fetch.mockRestore();
    clearVaultResetRunsForTest();
    clearNotices();
  }
});

it("does not complete the tracked job from a mismatched Host job response", async () => {
  clearVaultResetRunsForTest();
  clearNotices();
  setVaultResetRunPhase(
    "personal",
    "item-1",
    "in-progress",
    null,
    new Date(),
    "job-1",
  );
  const receipt = new Response(
    JSON.stringify({ id: "job-other", status: "succeeded" }),
  );
  const readReceipt = vi.spyOn(receipt, "json");
  const fetch = vi
    .spyOn(identitySeams, "hostFetch")
    .mockImplementation(async (path) => {
      if (path === "/api/v1/agent/runs")
        return new Response(JSON.stringify({ runs: [] }));
      return receipt;
    });
  const controller = new AbortController();
  try {
    createHostResetRunNoticeBridge().start(controller.signal);
    await vi.waitFor(() => expect(readReceipt).toHaveBeenCalledOnce());
    const read = readReceipt.mock.results[0];
    if (!read || read.type !== "return")
      throw new Error("Missing Host receipt");
    await read.value;
    await Promise.resolve();
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("in-progress");
  } finally {
    controller.abort();
    fetch.mockRestore();
    clearVaultResetRunsForTest();
    clearNotices();
  }
});
