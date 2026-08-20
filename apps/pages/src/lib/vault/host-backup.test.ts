import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { overlapCast } from "@opensesame/os-domain";

const hostFetch = vi.hoisted(() => vi.fn());
const ensureHostSession = vi.hoisted(() => vi.fn());
import { identitySeams } from "../identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {hostFetch,
  ensureHostSession,
  hostLocalSessionEligible: () => true});
import { projectSeams } from "../projects.js";
const originalProjectSeams = { ...projectSeams };
Object.assign(projectSeams, {
  activeProject: () => ({ id: "personal", name: "Personal", kind: "personal" }),
});

import {
  flushPendingVaultHostBackup,
  getVaultHostBackupState,
  pushSealedVaultToHost,
} from "./host-backup.js";
import {
  clearOfflineMutations,
  listOfflineMutations,
} from "./offline-backup.js";

describe("vault host backup", () => {
  beforeEach(() => {
    hostFetch.mockReset();
    ensureHostSession.mockResolvedValue({});
    clearOfflineMutations();
  });

  afterEach(() => {
    clearOfflineMutations();
  });

  it("pushes sealed header+body ciphertext to Host sync blobs", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ accepted: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await pushSealedVaultToHost({
      headerJson: '{"v":1,"wrap":{}}',
      bodyJson: '{"ct":"sealed"}',
      epoch: 3,
    });
    expect(hostFetch).toHaveBeenCalledWith(
      "/api/v1/sync/blobs/push",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = overlapCast(hostFetch.mock.calls[0]);
    const body = overlapCast(JSON.parse(String(init.body)));
    expect(body.blobs.map((b) => b.id)).toEqual(["vault:header", "vault:body"]);
    expect(body.blobs.every((b) => b.ciphertext.length > 0)).toBe(true);
    expect(body.blobs.every((b) => b.epoch === 3)).toBe(true);
    expect(getVaultHostBackupState().lastError).toBeNull();
    expect(listOfflineMutations()).toHaveLength(0);
  });

  it("queues ciphertext when Host is unreachable", async () => {
    hostFetch.mockRejectedValue(new Error("network down"));
    await pushSealedVaultToHost({
      headerJson: '{"v":1}',
      bodyJson: '{"ct":"x"}',
      epoch: 1,
    });
    expect(listOfflineMutations().some((m) => m.kind === "push_sync_blobs")).toBe(
      true,
    );
    expect(getVaultHostBackupState().lastError).toMatch(/Not on GitHub yet/);
  });

  it("flushes queued pushes when Host returns", async () => {
    hostFetch.mockRejectedValueOnce(new Error("offline"));
    await pushSealedVaultToHost({
      headerJson: '{"v":1}',
      bodyJson: '{"ct":"x"}',
      epoch: 2,
    });
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ accepted: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const flushed = await flushPendingVaultHostBackup();
    expect(flushed).toBeGreaterThan(0);
    expect(listOfflineMutations()).toHaveLength(0);
  });
});
