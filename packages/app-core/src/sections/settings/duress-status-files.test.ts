import { describe, expect, it } from "vitest";
import {
  DURESS_STATUS_FILE,
  type DuressDeviceStatus,
  type DuressFilePorts,
  duressStatusFiles,
} from "./duress-status-files.js";

function files(status: DuressDeviceStatus, owner = true) {
  const ports: DuressFilePorts = {
    owner: () => owner,
    status: () => status,
    profileId: "device-duress",
  };
  return duressStatusFiles(ports);
}

describe("the duress code's status as a read-only file (ADR 0134; ADR 0155)", () => {
  it("lists one read-only file to the owner and nothing to anyone else", () => {
    const listed = files({ armed: false, incidents: 0 }).list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      path: DURESS_STATUS_FILE,
      readOnly: true,
      removable: false,
    });
    expect(files({ armed: true, incidents: 0 }, false).list()).toEqual([]);
  });

  it("reports armed, the profile and the fence as facts", async () => {
    const read = async (status: DuressDeviceStatus) =>
      JSON.parse(await files(status).read(DURESS_STATUS_FILE));
    expect(await read({ armed: false, incidents: 0 })).toEqual({
      armed: false,
      profile: null,
      incident_fence: false,
    });
    expect(await read({ armed: true, incidents: 0 })).toEqual({
      armed: true,
      profile: "device-duress",
      incident_fence: false,
    });
    expect(await read({ armed: true, incidents: 3 })).toEqual({
      armed: true,
      profile: "device-duress",
      incident_fence: true,
    });
  });

  it("carries no count, id, code or seal: three keys, whatever the status", async () => {
    const text = await files({ armed: true, incidents: 7 }).read(
      DURESS_STATUS_FILE,
    );
    expect(Object.keys(JSON.parse(text))).toEqual([
      "armed",
      "profile",
      "incident_fence",
    ]);
    expect(text).not.toContain("7");
  });

  it("can never set, replace, remove or clear a code from a file", async () => {
    const provider = files({ armed: true, incidents: 1 });
    const before = await provider.read(DURESS_STATUS_FILE);
    const edits = [
      '{"armed":false,"profile":null,"incident_fence":false}',
      '{"armed":true,"code":"123456"}',
      "",
    ];
    for (const text of edits) {
      expect(provider.check(DURESS_STATUS_FILE, text).ok).toBe(false);
      expect((await provider.write(DURESS_STATUS_FILE, text)).ok).toBe(false);
    }
    expect((await provider.remove(DURESS_STATUS_FILE)).ok).toBe(false);
    expect(await provider.read(DURESS_STATUS_FILE)).toBe(before);
  });

  it("answers as if absent when no owner is at the device", async () => {
    const provider = files({ armed: true, incidents: 0 }, false);
    await expect(provider.read(DURESS_STATUS_FILE)).rejects.toThrow();
  });

  it("reads no other path", async () => {
    await expect(
      files({ armed: true, incidents: 0 }).read("settings/security/duress/x"),
    ).rejects.toThrow();
  });
});
