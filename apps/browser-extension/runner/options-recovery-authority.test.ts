// @vitest-environment jsdom
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { flushRetiredCredentialTelemetry } from "@opensesame/app-core/lib/retired-credentials/telemetry-queue.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  button,
  field,
  fixture,
  gate,
  unlock,
} from "./options-recovery.test-support";
import { clickSecurityAction } from "./test-support/security-action";
const revealed = () => document.getElementById("revealed")?.textContent;
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  f?.bridge.close();
  await f?.bridge.drain();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await flushRetiredCredentialTelemetry();
  vaultStore.lock();
  await kvFlush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
async function lock() {
  await clickSecurityAction(button("Lock vault"));
  expect(document.querySelector("#security")?.textContent).not.toContain(
    "Vault open",
  );
}
async function syntheticThenOwner() {
  await lock();
  const password = document.querySelector('#security input[type="password"]');
  if (!(password instanceof HTMLInputElement))
    throw new Error("Missing genuine unlock input");
  password.value = "retired-recovery-synthetic-fixture";
  await clickSecurityAction(button("Unlock vault"));
  expect(document.querySelector("#security")?.textContent).toContain(
    "Example account",
  );
  expect(document.querySelector("#security")?.textContent).not.toContain(
    "Owner recovery fixture",
  );
  expect(
    document.querySelector<HTMLElement>("#production-controls")?.hidden,
  ).toBe(true);
  await lock();
  await unlock(f.owner.password, f.handle);
  expect(document.querySelector("#security")?.textContent).toContain(
    "Owner recovery fixture",
  );
  field("reveal-key").value = JSON.stringify(f.pair.privateJwk);
}
async function waitGate(held: ReturnType<typeof gate>, label: string) {
  let reached = false;
  await held.promise.then(() => {
    reached = true;
  });
  expect(reached, label).toBe(true);
}
it("withholds held genuine decrypt through synthetic and fresh successor, then admits new recovery", async () => {
  await f.page.recover(f.handle);
  expect(revealed()).toBe(f.candidate);
  const decrypted = gate();
  const resume = gate();
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let armed = true;
  const decrypt = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      const algorithm = args[0];
      if (
        armed &&
        algorithm instanceof Object &&
        algorithm.name === "AES-GCM" &&
        "additionalData" in algorithm &&
        new TextDecoder()
          .decode(algorithm.additionalData)
          .startsWith("opensesame.runner-backup.v1")
      ) {
        armed = false;
        decrypted.finish();
        await resume.promise;
      }
      return result;
    });
  const pending = f.page.recover(f.handle);
  try {
    await waitGate(decrypted, "Genuine final AES decrypt reached");
    await syntheticThenOwner();
    resume.finish();
    await pending;
    expect(revealed()).toBe("");
    expect(document.getElementById("hint")?.textContent).toBe("");
  } finally {
    resume.finish();
    await pending;
    decrypt.mockRestore();
  }
  await f.page.recover(f.handle);
  expect(revealed()).toBe(f.candidate);
});
it("admits genuine multi-page recovery but forbids stale descendant paging and error publication", async () => {
  const positive = gate();
  f.transport.hold = positive;
  f.transport.started = gate();
  const first = f.transport.calls;
  const valid = f.page.recover(f.handle);
  await waitGate(f.transport.started, "Valid first page reached");
  positive.finish();
  await valid;
  expect(f.transport.calls - first).toBe(2);
  expect(revealed()).toBe(f.candidate);
  const held = gate();
  f.transport.hold = held;
  f.transport.started = gate();
  const before = f.transport.calls;
  const pending = f.page.recover(f.handle);
  try {
    await waitGate(f.transport.started, "Held first page reached");
    await syntheticThenOwner();
    held.finish();
    await pending;
    expect(f.transport.calls - before).toBe(1);
    expect(revealed()).toBe("");
    expect(document.getElementById("hint")?.textContent).toBe("");
  } finally {
    held.finish();
    await pending;
  }
  await f.page.recover(f.handle);
  expect(revealed()).toBe(f.candidate);
});
it("withholds genuinely generated predecessor key and admits a new owner key, clearing its actual textarea on lock", async () => {
  const generated = gate();
  const resume = gate();
  const original = crypto.subtle.generateKey.bind(crypto.subtle);
  const generate = vi
    .spyOn(crypto.subtle, "generateKey")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] instanceof Object && args[0].name === "RSA-OAEP") {
        generated.finish();
        await resume.promise;
      }
      return result;
    });
  const pending = f.page.createOwnerRecoveryKey();
  try {
    await waitGate(generated, "Genuine RSA key generated");
    await syntheticThenOwner();
    resume.finish();
    await pending;
    expect(field("recovery-private").value).toBe("");
  } finally {
    resume.finish();
    await pending;
    generate.mockRestore();
  }
  await f.page.createOwnerRecoveryKey();
  expect(JSON.parse(field("recovery-private").value).d).toBeDefined();
  expect(
    document.querySelector<HTMLElement>("#recovery-private-field")?.hidden,
  ).toBe(false);
  await lock();
  expect(field("recovery-private").value).toBe("");
  await unlock(f.owner.password, f.handle);
});
function holdSeal(name: string) {
  const started = gate();
  const resume = gate();
  const original = crypto.subtle.encrypt.bind(crypto.subtle);
  let armed = true;
  const spy = vi
    .spyOn(crypto.subtle, "encrypt")
    .mockImplementation(async (...args) => {
      const sealed = await original(...args);
      const algorithm = args[0];
      if (
        armed &&
        algorithm instanceof Object &&
        "additionalData" in algorithm &&
        new TextDecoder().decode(algorithm.additionalData).includes(name)
      ) {
        armed = false;
        started.finish();
        await resume.promise;
      }
      return sealed;
    });
  return { started, resume, spy };
}
async function staleSeal(name: string, operation: () => Promise<void>) {
  const before = [...f.rows];
  const held = holdSeal(name);
  const pending = operation();
  try {
    await waitGate(
      held.started,
      "Actual recipient/token/credential seal reached",
    );
    await syntheticThenOwner();
    held.resume.finish();
    await pending;
    expect([...f.rows]).toEqual(before);
    expect(document.getElementById("hint")?.textContent).toBe("");
  } finally {
    held.resume.finish();
    await pending;
    held.spy.mockRestore();
  }
}
it("does not pin a held predecessor recipient into a fresh owner, while a current pin succeeds", async () => {
  field("recovery-public").value = JSON.stringify(f.pair.recipient.jwk);
  await staleSeal("runner.recovery.recipient", f.page.pinRecovery);
  field("recovery-public").value = JSON.stringify(f.pair.recipient.jwk);
  await f.page.pinRecovery();
  expect(field("recovery-public").value).toBe("");
  expect(f.rows.has("runner.recovery.recipient")).toBe(true);
});
it("does not write held predecessor token or credential seals, while current successor writes succeed", async () => {
  field("token").value = "generated-predecessor-session";
  await staleSeal("runner.host.token", f.page.saveToken);
  field("token").value = "generated-successor-session";
  await f.page.saveToken();
  expect(field("token").value).toBe("");
  const form = document.getElementById("credential");
  if (!(form instanceof HTMLFormElement))
    throw new Error("Missing actual credential form");
  const credential: [string, string][] = [
    ["origin", "https://credential.example"],
    ["username", "fixture"],
    ["password", "generated-credential-value"],
  ];
  for (const [name, value] of credential) {
    const input = form.elements.namedItem(name);
    if (!(input instanceof HTMLInputElement) || !value)
      throw new Error("Missing actual credential input");
    input.value = value;
  }
  await staleSeal("runner.vault.", () => f.page.saveCredential(form));
  for (const [name, value] of credential) {
    const input = form.elements.namedItem(name);
    if (!(input instanceof HTMLInputElement) || !value)
      throw new Error("Missing actual credential input");
    input.value = value;
  }
  await f.page.saveCredential(form);
  expect(
    [...f.rows.keys()].some((key) => key.startsWith("runner.vault.")),
  ).toBe(true);
});
it("an earlier recovery display timer cannot clear a newer display in the same real session", async () => {
  field("reveal-key").value = JSON.stringify(f.pair.privateJwk);
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    await f.page.recover(f.handle);
    const earlier = timers.mock.calls.find(
      ([, delay]) => delay === 30_000,
    )?.[0];
    if (!(earlier instanceof Function))
      throw new Error("Missing actual recovery display timer");
    await f.page.recover(f.handle);
    earlier();
    expect(revealed()).toBe(f.candidate);
  } finally {
    timers.mockRestore();
  }
});
it("withholds a stale failed Host result instead of publishing an error into a fresh owner", async () => {
  const held = gate();
  f.transport.hold = held;
  f.transport.started = gate();
  f.transport.failure = true;
  const pending = f.page.recover(f.handle);
  try {
    await waitGate(f.transport.started, "Actual failed delivery held");
    await syntheticThenOwner();
    held.finish();
    await pending;
    expect(document.getElementById("hint")?.textContent).toBe("");
    expect(revealed()).toBe("");
  } finally {
    held.finish();
    await pending;
  }
  await f.page.recover(f.handle);
  expect(revealed()).toBe(f.candidate);
});
it("does not migrate a held legacy Host setting under a successor, while fresh migration succeeds", async () => {
  f.rows.set("hostApiBase", "http://127.0.0.1:8787");
  await staleSeal("hostApiBase", () => f.page.recover(f.handle));
  expect(f.rows.get("hostApiBase")).toBe("http://127.0.0.1:8787");
  await f.page.recover(f.handle);
  expect(f.rows.get("hostApiBase")?.startsWith("osc2.")).toBe(true);
  expect(revealed()).toBe(f.candidate);
});
