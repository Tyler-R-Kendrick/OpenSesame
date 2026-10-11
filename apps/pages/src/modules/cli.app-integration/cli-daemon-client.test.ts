import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliDaemonClientSeams,
  listCliIntegrationPending,
  respondCliIntegration,
} from "./cli-daemon-client.js";

describe("cli daemon client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists pending rows from the daemon", async () => {
    cliDaemonClientSeams.base = () => "http://127.0.0.1:18790";
    cliDaemonClientSeams.fetch = vi.fn(async () =>
      Response.json({
        pending: [
          {
            requestId: "clr_1",
            terminalSessionId: "term-a",
            verb: "read",
            reference: "op://dev/api/token",
          },
        ],
      }),
    );
    const rows = await listCliIntegrationPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("clr_1");
  });

  it("posts approve decisions", async () => {
    cliDaemonClientSeams.base = () => "http://127.0.0.1:18790";
    cliDaemonClientSeams.fetch = vi.fn(async () =>
      Response.json({ status: "approved" }),
    );
    await expect(
      respondCliIntegration("clr_1", "term-a", "approve"),
    ).resolves.toBe(true);
  });
});
