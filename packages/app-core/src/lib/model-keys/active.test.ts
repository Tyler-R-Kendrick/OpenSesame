import { afterEach, describe, expect, it } from "vitest";
import {
  activeModelKeyBroker,
  bindModelKeyBroker,
  modelKeysVersion,
} from "./active.js";
import { expectRefused, harness, newSigner } from "./harness.test-support.js";

const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});

function bind(h: ReturnType<typeof harness>) {
  const release = bindModelKeyBroker(h.broker);
  releases.push(release);
  return release;
}

describe("the page's broker", () => {
  it("ends the keys of the broker a new one replaces", async () => {
    const a = harness();
    const b = harness();
    const signer = await newSigner();
    const keyA = await a.root(signer);
    const keyB = await b.root(signer);
    bind(a);
    await expect(
      a.call(keyA.token, signer, { body: a.chat() }),
    ).resolves.toBeDefined();

    bind(b);

    expect(activeModelKeyBroker()).toBe(b.broker);
    expect(a.broker.list()).toEqual([]);
    await expectRefused(
      a.call(keyA.token, signer, { body: a.chat() }),
      "invalid_token",
      "key.inactive",
    );
    await expectRefused(
      a.exchange(keyA.token, null, { signer }),
      "invalid_grant",
      "subject.unknown",
    );
    // the new broker's own keys are untouched by the replacement
    await expect(
      b.call(keyB.token, signer, { body: b.chat() }),
    ).resolves.toBeDefined();
  });

  it("lets a superseded broker's release end its keys without disturbing the current one", async () => {
    const a = harness();
    const b = harness();
    const signer = await newSigner();
    const releaseA = bind(a);
    bind(b);
    const keyA = await a.root(signer);
    const keyB = await b.root(signer);
    const before = modelKeysVersion();

    releaseA();

    expect(a.broker.list()).toEqual([]);
    await expectRefused(
      a.call(keyA.token, signer, { body: a.chat() }),
      "invalid_token",
      "key.inactive",
    );
    expect(activeModelKeyBroker()).toBe(b.broker);
    expect(b.broker.list()).toHaveLength(1);
    await expect(
      b.call(keyB.token, signer, { body: b.chat() }),
    ).resolves.toBeDefined();
    expect(modelKeysVersion()).toBe(before);
  });

  it("is released once by its own release, and a second release changes nothing", async () => {
    const a = harness();
    const b = harness();
    const signer = await newSigner();
    const releaseA = bind(a);
    releaseA();
    expect(activeModelKeyBroker()).toBeNull();
    bind(b);
    const keyB = await b.root(signer);
    releaseA();
    expect(activeModelKeyBroker()).toBe(b.broker);
    await expect(
      b.call(keyB.token, signer, { body: b.chat() }),
    ).resolves.toBeDefined();
  });

  it("keeps the keys of a broker that is bound again as itself", async () => {
    const a = harness();
    const signer = await newSigner();
    const keyA = await a.root(signer);
    bind(a);
    bind(a);
    await expect(
      a.call(keyA.token, signer, { body: a.chat() }),
    ).resolves.toBeDefined();
  });
});
