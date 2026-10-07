import { expect, it, vi } from "vitest";
import {
  installOpfs,
  makeOpfs,
} from "../duress/wipe/fake-opfs.test-support.js";
import { kvFileName, kvGet } from "../kv.js";
import { configureObservationReceiver } from "./receiver.js";
import { outboxKey, receiverKey } from "./storage.js";
import { fixture, owner, provision } from "./test-support.js";
it("public owner lock during actual persistent config read prevents later provisioning writes", async () => {
  const root = makeOpfs();
  installOpfs(root);
  const f = await fixture();
  await configureObservationReceiver({
    ...owner,
    provision: provision(),
    enabled: false,
  });
  const before = kvGet(receiverKey("personal"));
  const outbox = kvGet(outboxKey("personal"));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const original = root.getFileHandle;
  const spy = vi
    .spyOn(root, "getFileHandle")
    .mockImplementation(async (name, options) => {
      const handle = await original(name, options);
      if (name !== kvFileName(outboxKey("personal")) || options?.create)
        return handle;
      return {
        ...handle,
        async getFile() {
          arrived();
          await pending;
          return handle.getFile();
        },
      };
    });
  const operation = configureObservationReceiver({
    ...owner,
    provision: { ...provision(), bindingId: "replacement-binding" },
    enabled: true,
  });
  const rejection = expect(operation).rejects.toThrow();
  await seen;
  f.store.lock();
  release();
  await rejection;
  spy.mockRestore();
  vi.unstubAllGlobals();
  expect(kvGet(receiverKey("personal"))).toBe(before);
  expect(kvGet(outboxKey("personal"))).toBe(outbox);
  expect(f.store.getSnapshot().status).toBe("locked");
});
