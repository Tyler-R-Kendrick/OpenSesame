import type { DeviceClient } from "@opensesame/app-core/lib/live/device-client.js";
import type { DeviceResetGrant } from "@opensesame/app-core/lib/live/device-reset-messages.js";
import type { DeviceSession } from "@opensesame/app-core/lib/live/device-session.js";
import type { ResetAction, ResetRun } from "@opensesame/cua-password-reset";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { LiveResetApprovals } from "./password-reset-approvals.js";
import type { LoadedResetConfiguration } from "./password-reset-config.js";

const ACTION: ResetAction = "password_reset.domain_metadata.list";
const OTHER_ACTION: ResetAction = "password_reset.item.use";

function fixture() {
  const reply: DeviceResetGrant = overlapCast({
    grant: "grant-1",
    expiresAt: Date.now() + 60_000,
    digest: `sha256:${"a".repeat(64)}`,
  });
  const requests: string[] = [];
  const reset = vi.fn<DeviceClient["reset"]>(async (req) => {
    requests.push(req);
    return reply;
  });
  const resetStatus = vi.fn<DeviceClient["resetStatus"]>(async () => undefined);
  const session: DeviceSession = overlapCast({
    client: { reset, resetStatus },
  });
  const approvals = new LiveResetApprovals(session, {
    actorInstanceId: "agent-instance",
    proofKeyThumbprint: "proof-key",
  });
  const run: ResetRun = overlapCast({
    id: "run-1",
    domain: "accounts.example.test",
    origin: "https://accounts.example.test",
    itemId: "item-1",
  });
  const loaded: LoadedResetConfiguration = overlapCast({
    config: { runtime: { model: "decision-model" } },
  });
  return { approvals, loaded, requests, resetStatus, run };
}

describe("password reset approval request binding", () => {
  it("is deterministic for a run and action, distinct across both, and correlated with status", async () => {
    const { approvals, loaded, requests, resetStatus, run } = fixture();
    await approvals.approve(ACTION, run, loaded);
    await approvals.approve(ACTION, run, loaded);
    await approvals.approve(OTHER_ACTION, run, loaded);
    await approvals.approve(ACTION, { ...run, id: "run-2" }, loaded);

    expect(requests[0]).toBe(requests[1]);
    expect(new Set(requests).size).toBe(3);
    expect(requests.every((request) => /^[a-f0-9]{24}$/u.test(request))).toBe(
      true,
    );
    const first = requests[0];
    if (!first) throw new Error("Missing approval request");
    await approvals.status(run, ACTION, "takeover_requested");
    expect(resetStatus).toHaveBeenCalledWith(
      `status-${first}`,
      `reset-${first}`,
      "takeover_requested",
    );
  });
});
