import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() => vi.fn());
vi.mock("./identity.js", () => ({ hostFetch }));

import {
  getBackupStatus,
  installationIdFromLocation,
  putBackupTarget,
} from "./backup.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("backup workflow client", () => {
  beforeEach(() => {
    hostFetch.mockReset();
  });

  it("reads target and queue depth from Host", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        target: {
          integration_id: "int-1",
          installation_id: "777",
          owner: "acme",
          repo: "opensesame-passwords",
          branch: "main",
          enabled: true,
          status: "ok",
          last_commit_sha: "abc",
          last_synced_at: "2026-08-17T00:00:00Z",
          last_error: null,
        },
        pending_events: 2,
      }),
    );
    const status = await getBackupStatus();
    expect(status.pendingEvents).toBe(2);
    expect(status.target?.repo).toBe("opensesame-passwords");
    expect(status.target?.status).toBe("ok");
  });

  it("configures a target with snake_case wire fields", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        target: {
          integration_id: "int-1",
          installation_id: "777",
          owner: "acme",
          repo: "r",
          branch: "main",
          enabled: true,
          status: "pending",
        },
      }),
    );
    await putBackupTarget({
      integrationId: "int-1",
      installationId: "777",
      owner: "acme",
      repo: "r",
    });
    const [, init] = hostFetch.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.integration_id).toBe("int-1");
    expect(sent.installation_id).toBe("777");
    expect(sent.owner).toBe("acme");
  });

  it("surfaces the server hint on refusal", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(422, {
        error: "integration_unusable",
        hint: "register the app first",
      }),
    );
    await expect(
      putBackupTarget({
        integrationId: "x",
        installationId: "1",
        owner: "a",
        repo: "b",
      }),
    ).rejects.toThrow(/register the app first/);
  });

  it("extracts the installation id GitHub appends to the setup redirect", () => {
    expect(
      installationIdFromLocation(
        "?installation_id=123456&setup_action=install",
      ),
    ).toBe("123456");
    expect(installationIdFromLocation("?installation_id=evil'--")).toBeNull();
    expect(installationIdFromLocation("")).toBeNull();
  });
});
