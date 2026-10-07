import { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import * as core from "@opensesame/app-core/browser/security/core.js";
import { useClientAtRestKeys } from "@opensesame/browser-at-rest";
import { expect } from "vitest";
import { persistentBrowserOwner } from "../../../../packages/app-core/src/browser/security-integration/management-host.fixture";
import { runnerListener } from "../security-listener";
import { isOwnPage } from "../sender";
import { createRunnerService } from "../service";
import { RunnerSettings } from "../settings";
import { SealedKv } from "../store";
import { RunnerVault } from "../vault";
import { MemoryStore } from "./memory";

const activeClosers = new Set<() => void>();
export function closeGenuineRunnerFixtures() {
  for (const close of [...activeClosers]) close();
}

export const ORIGIN = "https://public-runner-fixture.invalid";
const OWN = "abcdefghijklmnopabcdefghijklmnop";
const BASE = `chrome-extension://${OWN}/`;
const SENDER = { id: OWN, url: `${BASE}popup.html` };

function latch() {
  let finish: () => void = () => {
    throw new Error("Uninitialized latch");
  };
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}

export class HeldPhysicalStore extends MemoryStore {
  reads = 0;
  private readonly releases = new Set<() => void>();
  releaseAll() {
    for (const release of this.releases) release();
    this.releases.clear();
  }
  private hold: {
    kind: "keys" | "arm";
    started: ReturnType<typeof latch>;
    resume: ReturnType<typeof latch>;
  } | null = null;
  holdNext(kind: "keys" | "arm") {
    const hold = { kind, started: latch(), resume: latch() };
    this.hold = hold;
    this.releases.add(hold.resume.finish);
    return { started: hold.started.promise, release: hold.resume.finish };
  }
  private async pause(kind: "keys" | "arm") {
    const hold = this.hold;
    if (!hold || hold.kind !== kind) return;
    this.hold = null;
    hold.started.finish();
    await hold.resume.promise;
    this.releases.delete(hold.resume.finish);
  }
  override async get(key: string) {
    this.reads += 1;
    return super.get(key);
  }
  override async keys() {
    this.reads += 1;
    const keys = await super.keys();
    await this.pause("keys");
    return keys;
  }
  override async set(key: string, value: string) {
    // Hold only after production AES-GCM has produced and physically stored its envelope.
    await super.set(key, value);
    if (key === "runner.armed") await this.pause("arm");
  }
}

export async function genuineRunnerPermit() {
  const owner = await persistentBrowserOwner();
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  useClientAtRestKeys(async () => key);
  const clock = { now: Date.now() };
  const broker = new ExtensionRealmBroker({
    revision: core.extensionVaultRevision,
    classify: core.classifyExtensionPassword,
    now: () => clock.now,
  });
  const port = broker.attach();
  let requestId = 0;
  const unlock = async (password: string = owner.password) =>
    port.handle({ id: requestId++, op: "unlock", password });
  const initial = await unlock();
  expect(initial.realm).toBe("real");
  expect(initial.permit).toBeDefined();
  const raw = new HeldPhysicalStore();
  const close = () => {
    raw.releaseAll();
    port.close();
    activeClosers.delete(close);
  };
  activeClosers.add(close);
  const kv = new SealedKv(raw);
  const settings = new RunnerSettings(kv, () => clock.now);
  const vault = new RunnerVault(kv);
  await vault.putEntry({
    origin: ORIGIN,
    username: "public-user",
    password: "public-runner-value",
  });
  const granted = new Set([ORIGIN]);
  const revoked: string[] = [];
  let connections = 0;
  const runner = createRunnerService({
    settings,
    vault,
    grants: {
      has: async (origin) => granted.has(origin),
      revoke: async (origin) => {
        granted.delete(origin);
        revoked.push(origin);
      },
      privateAllowed: async () => false,
    },
    pagesFor: async () => {
      throw new Error("No external page may open in this no-session fixture");
    },
    closePage: async () => {
      throw new Error("No external page exists");
    },
    connect: async () => {
      connections += 1;
      expect(await settings.token()).toBeNull();
      return null;
    },
  });
  const listen = runnerListener(runner, broker, (sender) =>
    isOwnPage(sender, OWN, BASE),
  );
  function request(type: string, permit: string | undefined, origin = ORIGIN) {
    return new Promise<object>((resolve) => {
      expect(
        listen({ type, securityPermit: permit, origin }, SENDER, resolve),
      ).toBe(true);
    });
  }
  return {
    owner,
    clock,
    broker,
    port,
    initial,
    unlock,
    raw,
    settings,
    vault,
    runner,
    granted,
    revoked,
    request,
    close,
    get connections() {
      return connections;
    },
  };
}
