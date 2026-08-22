import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
const ensureHostSession = vi.hoisted(() => vi.fn());
const project = vi.hoisted(() => ({
  current: { id: "personal", name: "Personal", kind: "personal" },
  explode: false,
}));

import { identitySeams } from "../identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  hostFetch,
  ensureHostSession,
  hostLocalSessionEligible: () => true,
});
import { projectSeams } from "../projects.js";
const originalProjectSeams = { ...projectSeams };
Object.assign(projectSeams, {
  activeProject: () => {
    if (project.explode) throw new Error("no project yet");
    return project.current;
  },
});

import {
  flushPendingVaultHostBackup,
  getVaultHostBackupState,
  installVaultHostBackupFlushHooks,
  pushSealedVaultToHost,
  subscribeVaultHostBackup,
} from "./host-backup.js";
import {
  clearOfflineMutations,
  enqueueOfflineMutation,
  listOfflineMutations,
} from "./offline-backup.js";

function ok(overrides: JsonObject = {}): Response {
  return new Response(JSON.stringify({ accepted: 2, ...overrides }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function refused(status: number, body: JsonObject = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INPUT = {
  headerJson: '{"v":1,"wrap":{}}',
  bodyJson: '{"ct":"sealed"}',
  epoch: 4,
};

type PushBody = {
  blobs: Array<{ id: string; epoch: number; ciphertext: number[] }>;
};

function pushedBody(call = 0): PushBody {
  const init = hostFetch.mock.calls[call]?.[1];
  if (!init) throw new Error(`missing Host push ${call}`);
  const body: PushBody = overlapCast(JSON.parse(String(init.body)));
  return body;
}

beforeEach(() => {
  hostFetch.mockReset();
  ensureHostSession.mockReset().mockResolvedValue(undefined);
  project.current = { id: "personal", name: "Personal", kind: "personal" };
  project.explode = false;
  clearOfflineMutations();
});

afterEach(() => {
  clearOfflineMutations();
  vi.unstubAllGlobals();
});

describe("vault host backup state", () => {
  it("notifies subscribers on push outcomes until they unsubscribe", async () => {
    let calls = 0;
    const off = subscribeVaultHostBackup(() => {
      calls += 1;
    });
    hostFetch.mockResolvedValue(ok());
    await pushSealedVaultToHost(INPUT);
    expect(calls).toBeGreaterThan(0);

    off();
    const settled = calls;
    await pushSealedVaultToHost(INPUT);
    expect(calls).toBe(settled);
  });

  it("scopes blob ids to the active project", async () => {
    project.current = { id: "team-ops", name: "Ops", kind: "team" };
    hostFetch.mockResolvedValue(ok());
    await pushSealedVaultToHost(INPUT);
    const body = pushedBody();
    expect(body.blobs.map((b) => b.id)).toEqual([
      "project:team-ops:vault:header",
      "project:team-ops:vault:body",
    ]);
  });

  it("falls back to the personal scope when no project is known yet", async () => {
    project.explode = true;
    hostFetch.mockResolvedValue(ok());
    await pushSealedVaultToHost(INPUT);
    const body = pushedBody();
    expect(body.blobs.map((b) => b.id)).toEqual(["vault:header", "vault:body"]);
  });
});

describe("push failure modes", () => {
  it("queues when the browser says it is offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await pushSealedVaultToHost(INPUT);
    expect(hostFetch).not.toHaveBeenCalled();
    expect(listOfflineMutations()).toHaveLength(1);
    expect(getVaultHostBackupState().lastError).toMatch(/offline/);
  });

  it("prefers the Host's hint when a push is refused", async () => {
    hostFetch.mockResolvedValue(
      refused(413, { error: "too big", hint: "Vault export is too large" }),
    );
    await pushSealedVaultToHost(INPUT);
    expect(getVaultHostBackupState().lastError).toMatch(
      /Vault export is too large/,
    );
    expect(listOfflineMutations()).toHaveLength(1);
  });

  it("falls back to the error field, then to the status", async () => {
    hostFetch.mockResolvedValue(refused(500, { error: "boom" }));
    await pushSealedVaultToHost(INPUT);
    expect(getVaultHostBackupState().lastError).toMatch(/boom/);

    clearOfflineMutations();
    hostFetch.mockResolvedValue(refused(503));
    await pushSealedVaultToHost(INPUT);
    expect(getVaultHostBackupState().lastError).toMatch(/503/);
  });

  it("treats oversized rejections in a 200 as a failure", async () => {
    hostFetch.mockResolvedValue(ok({ rejected_oversize: 1 }));
    await pushSealedVaultToHost(INPUT);
    expect(getVaultHostBackupState().lastError).toMatch(/size limit/);
    expect(listOfflineMutations()).toHaveLength(1);
  });

  it("treats a 200 that accepted nothing as a failure", async () => {
    hostFetch.mockResolvedValue(ok({ accepted: 0 }));
    await pushSealedVaultToHost(INPUT);
    expect(getVaultHostBackupState().lastError).toMatch(/accepted no vault/);
  });

  it("tolerates a response with no JSON body at all", async () => {
    hostFetch.mockResolvedValue(
      new Response("not json", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    await pushSealedVaultToHost(INPUT);
    expect(getVaultHostBackupState().lastError).toMatch(/500/);
  });
});

describe("flushPendingVaultHostBackup", () => {
  function queueOne(): void {
    enqueueOfflineMutation({
      kind: "push_sync_blobs",
      blobs: [
        { id: "vault:header", epoch: 1, ciphertextB64: btoa("header") },
        { id: "vault:body", epoch: 1, ciphertextB64: btoa("body") },
      ],
    });
  }

  it("does nothing when the queue is empty", async () => {
    await expect(flushPendingVaultHostBackup()).resolves.toBe(0);
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("does nothing while offline", async () => {
    queueOne();
    vi.stubGlobal("navigator", { onLine: false });
    await expect(flushPendingVaultHostBackup()).resolves.toBe(0);
    expect(hostFetch).not.toHaveBeenCalled();
    expect(listOfflineMutations()).toHaveLength(1);
  });

  it("decodes queued base64 back into bytes for the push", async () => {
    queueOne();
    hostFetch.mockResolvedValue(ok());
    await expect(flushPendingVaultHostBackup()).resolves.toBe(1);
    const body = pushedBody();
    expect(body.blobs[0]?.ciphertext).toEqual(
      Array.from(new TextEncoder().encode("header")),
    );
    expect(listOfflineMutations()).toHaveLength(0);
  });

  it("drops queue entries that carry no blobs", async () => {
    enqueueOfflineMutation({
      kind: "push_sync_blobs",
      blobs: [],
    });
    hostFetch.mockResolvedValue(ok());
    await flushPendingVaultHostBackup();
    expect(listOfflineMutations()).toHaveLength(0);
  });

  it("stops at the first failure and keeps the rest queued", async () => {
    queueOne();
    queueOne();
    hostFetch.mockResolvedValue(refused(502, { hint: "Host is restarting" }));
    await expect(flushPendingVaultHostBackup()).resolves.toBe(0);
    expect(getVaultHostBackupState().lastError).toMatch(/Host is restarting/);
    expect(listOfflineMutations()).toHaveLength(2);
  });

  it("keeps the error visible while a later flush still has work queued", async () => {
    queueOne();
    hostFetch.mockResolvedValueOnce(ok());
    hostFetch.mockResolvedValueOnce(refused(500, { error: "still down" }));
    queueOne();
    await expect(flushPendingVaultHostBackup()).resolves.toBe(1);
    expect(getVaultHostBackupState().lastError).toMatch(/still down/);
    expect(listOfflineMutations()).toHaveLength(1);
  });
});

describe("installVaultHostBackupFlushHooks", () => {
  it("is a no-op outside a browser", () => {
    expect(() => installVaultHostBackupFlushHooks()).not.toThrow();
  });

  it("flushes on reconnect and on the tab becoming visible", async () => {
    const windowListeners = new Map<string, () => void>();
    const documentListeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (event: string, cb: () => void) =>
        windowListeners.set(event, cb),
    });
    vi.stubGlobal("document", {
      addEventListener: (event: string, cb: () => void) =>
        documentListeners.set(event, cb),
      visibilityState: "hidden",
    });
    // install runs flushPendingVaultHostBackup once at install; queue is empty.
    installVaultHostBackupFlushHooks();
    expect(windowListeners.has("online")).toBe(true);
    expect(documentListeners.has("visibilitychange")).toBe(true);

    enqueueOfflineMutation({
      kind: "push_sync_blobs",
      blobs: [{ id: "vault:body", epoch: 9, ciphertextB64: btoa("x") }],
    });
    hostFetch.mockResolvedValue(ok());

    windowListeners.get("online")?.();
    await vi.waitFor(() => {
      expect(listOfflineMutations()).toHaveLength(0);
    });

    // A hidden tab does nothing; a visible one flushes.
    enqueueOfflineMutation({
      kind: "push_sync_blobs",
      blobs: [{ id: "vault:body", epoch: 10, ciphertextB64: btoa("y") }],
    });
    documentListeners.get("visibilitychange")?.();
    expect(listOfflineMutations()).toHaveLength(1);

    overlapCast(document).visibilityState = "visible";
    documentListeners.get("visibilitychange")?.();
    await vi.waitFor(() => {
      expect(listOfflineMutations()).toHaveLength(0);
    });
  });
});
