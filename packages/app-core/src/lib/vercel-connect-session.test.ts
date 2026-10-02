import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armVercelConnectAuth,
  clearPendingVercelConnectAuth,
  disarmVercelConnectAuth,
  hydrateVercelConnectAuth,
  pendingVercelConnectAuth,
  readVercelConnectAuth,
} from "./vercel-connect-session.js";
import {
  setVercelConnectAuth,
  vercelConnectAuth,
  vercelConnectConfigured,
} from "./vercel-connect.js";
import * as vfs from "./vfs.js";

const tomb = "tomb_test";

afterEach(() => {
  clearPendingVercelConnectAuth();
  setVercelConnectAuth(null);
  vi.restoreAllMocks();
});

describe("Vercel Connect session handoff", () => {
  it("arms from memory before a vault exists and seals on hydrate", async () => {
    const writes: Array<{ path: string; body: string }> = [];
    vi.spyOn(vfs, "writeFile").mockImplementation(async (_t, path, bytes) => {
      writes.push({ path, body: new TextDecoder().decode(bytes) });
    });
    vi.spyOn(vfs, "readFile").mockImplementation(async (_t, path) => {
      const hit = writes.find((row) => row.path === path);
      if (!hit) {
        throw new vfs.VfsError("not-found", path);
      }
      return new TextEncoder().encode(hit.body);
    });

    await armVercelConnectAuth(
      { token: "vercel_token", teamId: "team_1" },
      null,
    );
    expect(vercelConnectConfigured()).toBe(true);
    expect(pendingVercelConnectAuth()?.token).toBe("vercel_token");
    expect(writes).toHaveLength(0);

    await expect(hydrateVercelConnectAuth(tomb)).resolves.toBe(true);
    expect(pendingVercelConnectAuth()).toBeNull();
    expect(writes[0]?.path).toBe("config/vercel-connect-auth");
    expect(JSON.parse(writes[0]?.body ?? "{}")).toMatchObject({
      version: 1,
      token: "vercel_token",
      teamId: "team_1",
    });
    expect(vercelConnectAuth()?.teamId).toBe("team_1");
  });

  it("arms nothing when the unlock ends while the sealed record is read", async () => {
    let answer: ((bytes: Uint8Array) => void) | undefined;
    vi.spyOn(vfs, "readFile").mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve) => {
          answer = resolve;
        }),
    );
    const unlock = new AbortController();
    const hydrating = hydrateVercelConnectAuth(tomb, { signal: unlock.signal });
    // The lock lands, and its disarm runs, before the read answers.
    unlock.abort("lock");
    disarmVercelConnectAuth();
    answer?.(
      new TextEncoder().encode(
        JSON.stringify({ version: 1, token: "sealed_token" }),
      ),
    );
    await expect(hydrating).resolves.toBe(false);
    expect(vercelConnectAuth()).toBeNull();
  });

  it("hydrates a sealed record on unlock and disarms on lock", async () => {
    vi.spyOn(vfs, "readFile").mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          token: "sealed_token",
          projectId: "prj_1",
        }),
      ),
    );

    await expect(hydrateVercelConnectAuth(tomb)).resolves.toBe(true);
    expect(vercelConnectAuth()).toEqual({
      token: "sealed_token",
      projectId: "prj_1",
    });
    await expect(readVercelConnectAuth(tomb)).resolves.toEqual({
      token: "sealed_token",
      projectId: "prj_1",
    });

    disarmVercelConnectAuth();
    expect(vercelConnectConfigured()).toBe(false);
  });

  it("seals immediately when a tomb is already open", async () => {
    const write = vi.spyOn(vfs, "writeFile").mockResolvedValue(undefined);
    await armVercelConnectAuth({ token: "live" }, tomb);
    expect(write).toHaveBeenCalledOnce();
    expect(pendingVercelConnectAuth()).toBeNull();
    expect(vercelConnectConfigured()).toBe(true);
  });

  it("never stages an ephemeral arm for a later seal", async () => {
    const write = vi.spyOn(vfs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(vfs, "readFile").mockRejectedValue(
      new vfs.VfsError("not-found", "config/vercel-connect-auth"),
    );

    await armVercelConnectAuth({ token: "guest_token" }, tomb, {
      ephemeral: true,
    });
    expect(vercelConnectConfigured()).toBe(true);
    expect(pendingVercelConnectAuth()).toBeNull();
    expect(write).not.toHaveBeenCalled();

    // A later non-ephemeral unlock must not seal the guest-staged credential.
    await expect(hydrateVercelConnectAuth(tomb)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(vercelConnectConfigured()).toBe(false);
  });
});
