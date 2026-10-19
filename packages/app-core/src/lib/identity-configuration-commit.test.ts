/** Common precommit forwarding only: post-close ownership and compensation belong to the caller. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { originFiles } from "../ports.js";
import * as records from "./device-connector-records.js";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import { writeIdentityConnection } from "./identity-connections-store.js";
import { projectIdentityTrust } from "./identity-connections-trust.js";
import { kvFileName, kvForgetAll, kvHydrate, kvSeams } from "./kv.js";
import {
  deferred,
  runtimeFixture,
} from "./secret-backends/runtime.test-support.js";
import {
  loadSettings,
  saveSettingsDurable,
  signInMethods,
  subscribeSettings,
} from "./settings.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
function draft() {
  return {
    ...identityConnectionDraft("byo-identity"),
    issuer: "https://identity.example.test",
    clientId: "owned-client",
    clientSecret: "public synthetic saved configuration",
  };
}
function authority() {
  let live = true;
  return {
    withdraw() {
      live = false;
    },
    assertCurrent: vi.fn(() => {
      if (!live) throw new Error("Original actor withdrew");
    }),
  };
}
async function holdFile(key: string) {
  const open = originFiles();
  if (!open) throw new Error("Expected owned OPFS fixture");
  const root = await open();
  const get = root.getFileHandle.bind(root);
  const reached = deferred<void>();
  const resume = deferred<void>();
  vi.spyOn(root, "getFileHandle").mockImplementation(async (name, options) => {
    const handle = await get(name, options);
    if (name === kvFileName(key)) {
      const create = handle.createWritable.bind(handle);
      vi.spyOn(handle, "createWritable").mockImplementation(async (options) => {
        const stream = await create(options);
        const write = stream.write.bind(stream);
        vi.spyOn(stream, "write").mockImplementation(async (data) => {
          await write(data);
          reached.resolve();
          await resume.promise;
        });
        return stream;
      });
    }
    return handle;
  });
  return { reached: reached.promise, resume: () => resume.resolve() };
}
it("checks a queued original guard before reading private configuration", async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  const previous = records.withDeviceConfigurationLock(async () => {
    entered.resolve();
    await resume.promise;
  });
  await entered.promise;
  const owner = authority();
  const read = vi.spyOn(records, "readDeviceSecrets");
  const write = vi.spyOn(kvSeams, "kvSetDurable");
  const pending = writeIdentityConnection(
    draft(),
    undefined,
    owner.assertCurrent,
  );
  const rejected = expect(pending).rejects.toThrow("Original actor withdrew");
  try {
    expect(owner.assertCurrent).not.toHaveBeenCalled();
    owner.withdraw();
    resume.resolve();
    await previous;
    await rejected;
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(records.readDeviceRows()).toEqual([]);
  } finally {
    resume.resolve();
    await previous;
  }
});
it.each([false, true])(
  "refuses staged connector persistence after withdrawal, replacing=%s",
  async (replacing) => {
    const old = replacing ? await writeIdentityConnection(draft()) : null;
    const rows = records.readDeviceRows();
    const secrets = records.readDeviceSecrets();
    const files = new Map(fixture.files);
    const owner = authority();
    const held = await holdFile(records.DEVICE_CONNECTOR_KEYS[2]);
    const pending = writeIdentityConnection(
      {
        ...draft(),
        name: "Attempted replacement",
        clientSecret: "public synthetic replacement configuration",
      },
      old?.connectionId,
      owner.assertCurrent,
    );
    const rejected = expect(pending).rejects.toThrow("Original actor withdrew");
    try {
      await held.reached;
      owner.withdraw();
      held.resume();
      await rejected;
      expect(records.readDeviceRows()).toEqual(rows);
      expect(records.readDeviceSecrets()).toEqual(secrets);
      expect(fixture.files).toEqual(files);
      kvForgetAll();
      await kvHydrate([...records.DEVICE_CONNECTOR_KEYS]);
      expect(records.readDeviceRows()).toEqual(rows);
      expect(records.readDeviceSecrets()).toEqual(secrets);
    } finally {
      held.resume();
    }
  },
);
it.each(["settings", "projection"] as const)(
  "does not publish %s trust when its actor withdraws after the sealed write stages",
  async (operation) => {
    const original = loadSettings();
    const providers = signInMethods().providers;
    const files = new Map(fixture.files);
    const owner = authority();
    const held = await holdFile("settings.v1");
    const changed = vi.fn();
    const unsubscribe = subscribeSettings(changed);
    const pending =
      operation === "settings"
        ? saveSettingsDurable(
            { ...original, identityApi: "https://new-identity.example.test" },
            owner.assertCurrent,
          )
        : projectIdentityTrust(
            { ...draft(), clientSecret: "" },
            "owned-connection",
            null,
            owner.assertCurrent,
          );
    const rejected = expect(pending).rejects.toThrow("Original actor withdrew");
    try {
      await held.reached;
      owner.withdraw();
      held.resume();
      await rejected;
      expect(loadSettings()).toEqual(original);
      expect(signInMethods().providers).toEqual(providers);
      expect(changed).not.toHaveBeenCalled();
      expect(fixture.files).toEqual(files);
      kvForgetAll();
      await kvHydrate(["settings.v1"]);
      expect(loadSettings()).toEqual(original);
    } finally {
      held.resume();
      unsubscribe();
    }
  },
);
it("default callers still persist real sealed configuration and public trust", async () => {
  const saved = await writeIdentityConnection(draft());
  await projectIdentityTrust(
    { ...draft(), clientSecret: "" },
    saved.connectionId,
  );
  expect(records.readDeviceSecrets()[saved.connectionId]?.clientSecret).toBe(
    draft().clientSecret,
  );
  expect(
    signInMethods().providers.find(
      (provider) => provider.connectionId === saved.connectionId,
    )?.issuer,
  ).toBe(draft().issuer);
  expect([...fixture.files.values()].join("\n")).not.toContain(
    draft().clientSecret,
  );
});
it("a precommit port does not pretend it can undo a close that already succeeded", async () => {
  const owner = authority();
  const durable = kvSeams.kvSetDurable;
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementationOnce(
    async (key, value, guard) => {
      await durable(key, value, guard);
      owner.withdraw(); // Physical close and memory publication already succeeded.
    },
  );
  const saved = await writeIdentityConnection(
    draft(),
    undefined,
    owner.assertCurrent,
  );
  expect(() => owner.assertCurrent()).toThrow("Original actor withdrew");
  expect(
    records
      .readDeviceRows()
      .some((row) => row.connectionId === saved.connectionId),
  ).toBe(true);
  kvForgetAll();
  await kvHydrate([...records.DEVICE_CONNECTOR_KEYS]);
  expect(records.readDeviceSecrets()[saved.connectionId]?.clientSecret).toBe(
    draft().clientSecret,
  );
});
