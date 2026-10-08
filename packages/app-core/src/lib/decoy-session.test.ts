/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  connectionSeams,
  createConnection,
  listConnections,
} from "./connections.js";
import {
  assertNotDecoySession,
  isDecoySession,
  markDecoySession,
} from "./decoy-session.js";
import { hostFetch, identityFetch, identitySeams } from "./identity.js";
import { resolveCurrentAccessRole } from "./local-rbac.js";
import { projectSeams, setActiveProject } from "./projects.js";
import { vaultStore } from "./vault/store.js";

afterEach(() => {
  markDecoySession(false);
  vi.restoreAllMocks();
});

it("blocks ambient transports and connector seams without a global incident", async () => {
  const host = vi.spyOn(identitySeams, "hostFetch");
  const identity = vi.spyOn(identitySeams, "identityFetch");
  const create = vi.spyOn(connectionSeams, "createConnection");
  const list = vi.spyOn(connectionSeams, "listConnections");
  const project = vi.spyOn(projectSeams, "setActiveProject");
  markDecoySession(true);
  await expect(resolveCurrentAccessRole("guest")).resolves.toBe("guest");
  await expect(hostFetch("/api/v1/test")).rejects.toThrow("authenticate again");
  await expect(identityFetch("/v1/principals/me")).rejects.toThrow(
    "authenticate again",
  );
  await expect(createConnection({ providerId: "github" })).rejects.toThrow(
    "authenticate again",
  );
  await expect(listConnections()).resolves.toEqual([]);
  await expect(setActiveProject("personal")).rejects.toThrow(
    "authenticate again",
  );
  for (const seam of [host, identity, create, list, project])
    expect(seam).not.toHaveBeenCalled();
});

it("requires ending the decoy before real unlock, export or import", async () => {
  markDecoySession(true);
  await expect(vaultStore.unlock("current")).rejects.toThrow(
    "authenticate again",
  );
  await expect(vaultStore.unlockWithPin("123456")).rejects.toThrow(
    "authenticate again",
  );
  await expect(
    vaultStore.unlockWithProtector({ method: "recovery", secret: "x" }),
  ).rejects.toThrow("authenticate again");
  expect(() => vaultStore.exportSealed()).toThrow("authenticate again");
  expect(() => vaultStore.importSealed("{}", "x")).toThrow(
    "authenticate again",
  );
  expect(isDecoySession()).toBe(true);
  markDecoySession(false);
  expect(() => assertNotDecoySession()).toThrow(/authenticate again/);
});

it("withholds an ambient request result that finishes after decoy entry", async () => {
  let finish: (value: Response) => void = () => undefined;
  vi.spyOn(identitySeams, "hostFetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = hostFetch("/api/v1/test");
  markDecoySession(true);
  finish(new Response("member response"));
  await expect(pending).rejects.toThrow("authenticate again");
});
