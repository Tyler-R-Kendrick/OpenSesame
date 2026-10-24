/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { resyncBackup } from "./backup.js";
import { useGithubBackupProviderFixture } from "./github-app-backup-provider.test-support.js";
import { forgetLocalGithubApp } from "./github-app-local.js";
import {
  captureSavedGithubBackup,
  reserveGithubBackupWrite,
  savedGithubBackupRequest,
} from "./vault-backup-github-owner.js";
import { vaultBackupObserverSeams } from "./vault-backup-observer.js";
import {
  drainBackupWebhooks,
  vaultBackupSyncSeams,
} from "./vault-backup-sync.js";
import { vaultStore } from "./vault/store.js";

const fixture = useGithubBackupProviderFixture();
function observed<T>(operation: Promise<T>) {
  return operation.then(
    () => ({ status: "fulfilled" as const }),
    () => ({ status: "rejected" as const }),
  );
}
function putRequests() {
  return fixture.requests.filter((row) => row.method === "PUT");
}
function putStatuses() {
  return fixture.outcomes
    .filter((row) => row.method === "PUT")
    .map((row) => row.status);
}
async function providerBarrier() {
  // Two genuine signed/provider roundtrips prove other provider work progresses while the first PUT remains held.
  await drainBackupWebhooks();
  await drainBackupWebhooks();
}
function capturedEnvelopes() {
  const original = vaultBackupSyncSeams.sealedEnvelopeJson;
  const captured: JsonObject[] = [];
  vi.spyOn(vaultBackupSyncSeams, "sealedEnvelopeJson").mockImplementation(
    () => {
      const text = original();
      captured.push(JSON.parse(text));
      return text;
    },
  );
  return captured;
}
async function freshPayload() {
  const item = createItem("note", "Distinct queued backup work");
  await vaultStore.saveItem(item);
  await vaultStore.flushPendingWrites();
}
it.each(["manual", "configured"] as const)(
  "serializes %s-first requests without joining their distinct original payloads",
  async (first) => {
    const held = fixture.holdNextWrite();
    const manual = () => resyncBackup("github");
    const configured = () => vaultBackupObserverSeams.runSync("configured");
    const originalPayloads = capturedEnvelopes();
    const firstResult = observed(first === "manual" ? manual() : configured());
    let secondResult: ReturnType<typeof observed> | null = null;
    try {
      await held.arrived;
      await freshPayload();
      secondResult = observed(first === "manual" ? configured() : manual());
      let settled = false;
      void secondResult.then(() => {
        settled = true;
      });
      await providerBarrier();
      await freshPayload(); // Later vault edits must not replace the already queued snapshot.
      expect(putRequests()).toHaveLength(1);
      expect(settled).toBe(false);
      expect(putStatuses()).toEqual([]);
      held.release();
      expect((await firstResult).status).toBe("fulfilled");
      expect((await secondResult).status).toBe("fulfilled");
      expect(putStatuses()).toEqual([201, 201]);
      expect(putRequests()).toHaveLength(2);
      const payloads = putRequests().map((row) =>
        JSON.parse(
          Buffer.from(JSON.parse(row.body).content, "base64").toString(),
        ),
      );
      expect(originalPayloads).toHaveLength(2);
      expect(payloads).toEqual(originalPayloads);
      expect(payloads[0]).not.toEqual(payloads[1]);
      expect(readLocalBackupTarget("github")).toMatchObject({
        status: "ok",
        lastCommitSha: fixture.head,
        pendingEvents: 0,
      });
      expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE KEY");
    } finally {
      held.release();
      await firstResult;
      await secondResult;
    }
  },
);
it("retains the fetch captured by the queued caller before waiting", async () => {
  const held = fixture.holdNextWrite();
  const first = observed(resyncBackup("github"));
  let second: ReturnType<typeof observed> | null = null;
  try {
    await held.arrived;
    second = observed(resyncBackup("github"));
    await providerBarrier();
    const replacement = vi.fn(async () => {
      throw new Error("Replacement fetch must not be adopted");
    });
    vi.stubGlobal("fetch", replacement);
    held.release();
    expect((await first).status).toBe("fulfilled");
    expect((await second).status).toBe("fulfilled");
    expect(putStatuses()).toEqual([201, 201]);
    expect(replacement).not.toHaveBeenCalled();
  } finally {
    held.release();
    await first;
    await second;
  }
});
it.each(["target", "key", "vault", "lease"] as const)(
  "rejects queued work immediately when its original %s is withdrawn",
  async (withdrawal) => {
    const held = fixture.holdNextWrite();
    const first = observed(resyncBackup("github"));
    let queued: ReturnType<typeof observed> | null = null;
    try {
      await held.arrived;
      queued = observed(resyncBackup("github"));
      await providerBarrier();
      const before = fixture.requests.length;
      const target = readLocalBackupTarget("github");
      if (!target) throw new Error("Missing original target");
      if (withdrawal === "target") {
        writeLocalBackupTarget({ ...target, repo: "withdrawn-repository" });
        writeLocalBackupTarget(target); // Returning public fields must not revive the parked owner.
      } else if (withdrawal === "key") forgetLocalGithubApp();
      else if (withdrawal === "lease") fixture.network.revoke();
      else {
        vaultStore.lock();
        await vaultStore.unlockWithPin("83619472");
      }
      expect((await queued).status).toBe("rejected");
      expect(fixture.requests).toHaveLength(before);
      held.release();
      expect((await first).status).toBe("rejected");
      expect(putRequests()).toHaveLength(1);
      if (withdrawal === "target") {
        await resyncBackup("github");
        expect(readLocalBackupTarget("github")?.status).toBe("ok");
        expect(putStatuses()).not.toContain(409);
      }
    } finally {
      held.release();
      await first;
      await queued;
    }
  },
);
it("refuses queued policy withdrawal before any next credential or provider egress", async () => {
  const held = fixture.holdNextWrite();
  const first = observed(resyncBackup("github"));
  let queued: ReturnType<typeof observed> | null = null;
  try {
    await held.arrived;
    queued = observed(resyncBackup("github"));
    await providerBarrier();
    const before = fixture.requests.length;
    fixture.network.network.mockReturnValue({
      externalServices: "allow",
      allowedServiceOrigins: ["https://other.example"],
    });
    held.release();
    expect((await first).status).toBe("rejected");
    expect((await queued).status).toBe("rejected");
    expect(fixture.requests).toHaveLength(before);
  } finally {
    held.release();
    await first;
    await queued;
  }
});
it("retains queued work and prior success when a later producer is denied, then permits a fresh retry", async () => {
  const held = fixture.holdNextWrite();
  const first = observed(resyncBackup("github"));
  let queued: ReturnType<typeof observed> | null = null;
  try {
    await held.arrived;
    queued = observed(vaultBackupObserverSeams.runSync("configured"));
    await providerBarrier();
    fixture.onWrite = () => {
      fixture.mode = "denied";
    };
    held.release();
    expect((await first).status).toBe("fulfilled");
    await queued; // Observer owns its rejection, actual provider denial remains observable below.
    expect(putStatuses()).toEqual([201]);
    expect(fixture.outcomes.some((row) => row.status === 403)).toBe(true);
    expect(readLocalBackupTarget("github")).toMatchObject({
      status: "error",
      pendingEvents: 1,
      lastCommitSha: fixture.head,
    });
    fixture.mode = "normal";
    fixture.onWrite = () => {};
    await resyncBackup("github");
    expect(putStatuses()).toEqual([201, 201]);
    expect(readLocalBackupTarget("github")).toMatchObject({
      status: "ok",
      pendingEvents: 0,
      lastCommitSha: fixture.head,
    });
  } finally {
    held.release();
    await first;
    await queued;
  }
});

it("serializes owner/repository case aliases while preserving case-sensitive branches", async () => {
  const target = readLocalBackupTarget("github");
  if (!target) throw new Error("Missing original saved target");
  const alias = "github-case-alias";
  const otherBranch = "github-case-branch";
  writeLocalBackupTarget({
    ...target,
    providerId: alias,
    owner: target.owner.toUpperCase(),
    repo: target.repo.toUpperCase(),
  });
  writeLocalBackupTarget({
    ...target,
    providerId: otherBranch,
    branch: "Backup/Primary",
  });
  const operations: ReturnType<typeof captureSavedGithubBackup>[] = [];
  const slots: ReturnType<typeof reserveGithubBackupWrite>[] = [];
  const outcomes: ReturnType<typeof observed>[] = [];
  try {
    for (const id of ["github", alias, otherBranch]) {
      const operation = captureSavedGithubBackup(savedGithubBackupRequest(id));
      operations.push(operation);
      const slot = reserveGithubBackupWrite(operation);
      slots.push(slot);
      outcomes.push(observed(slot.wait));
    }
    expect((await outcomes[0]).status).toBe("fulfilled");
    expect((await outcomes[2]).status).toBe("fulfilled");
    const probe = await Promise.race([
      outcomes[1].then(() => "entered"),
      (async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        return "parked";
      })(),
    ]);
    expect(probe).toBe("parked");
    slots[0].release();
    expect((await outcomes[1]).status).toBe("fulfilled");
    // This owner/queue contract test makes no provider call; the nine other cases exercise actual HTTP/default consumers.
    expect(fixture.requests).toEqual([]);
  } finally {
    for (const slot of slots) slot.release();
    for (const operation of operations) operation.close();
    await Promise.all(outcomes);
    clearLocalBackupTarget(alias);
    clearLocalBackupTarget(otherBranch);
  }
});
