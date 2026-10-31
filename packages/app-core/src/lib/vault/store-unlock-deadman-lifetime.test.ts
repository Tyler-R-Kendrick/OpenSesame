import { createItem } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import {
  commitDeadmanSwitch,
  disarmDeadmanSwitch,
  prepareDeadmanSwitch,
} from "../deadman/arm.js";
import * as deadmanCrypto from "../deadman/crypto.js";
import {
  deadmanSeams,
  readDeadmanState,
  recordDeadmanAuthentication,
} from "../deadman/state.js";
import { PASSWORD, newStore } from "./store-ops.fixture.js";
import {
  deferred,
  installUnlockRacesFixture,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

async function armedStore() {
  const store = newStore();
  await store.create(PASSWORD);
  let now = 1_790_000_000_000;
  vi.spyOn(deadmanSeams, "now").mockImplementation(() => now);
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  const item = createItem("note", "Synthetic deadman instruction");
  const arm = async () => {
    const plan = await prepareDeadmanSwitch({
      tomb: "personal",
      items: [item],
      itemIds: [item.id],
      timeoutDays: 30,
      relayUrl: "https://relay.example.test/deadman",
      webhookUrl: "https://agent.example.test/deadman",
    });
    await commitDeadmanSwitch(plan);
    return plan.id;
  };
  await arm();
  return {
    store,
    arm,
    fetch,
    setTime: (next: number) => {
      now = next;
    },
  };
}

function holdSignature(ordinal = 1) {
  const started = deferred();
  const gate = deferred();
  const sign = deadmanCrypto.signText;
  let calls = 0;
  vi.spyOn(deadmanCrypto, "signText").mockImplementation(async (...args) => {
    const signature = await sign(...args);
    if (++calls === ordinal) {
      started.release();
      await gate.promise;
    }
    return signature;
  });
  return { started: started.promise, release: gate.release };
}

it("an older completed unlock cannot overwrite the newer authenticated deadman time", async () => {
  const { store, setTime } = await armedStore();
  store.lock();
  const held = holdSignature();
  setTime(1_790_000_001_000);
  const old = store.unlock(PASSWORD);
  await held.started;
  try {
    store.lock();
    setTime(1_790_000_002_000);
    await store.unlock(PASSWORD);
    const current = readDeadmanState("personal");
    expect(current?.lastAuthenticatedAt).toBe(1_790_000_002_000);
    held.release();
    await old;
    expect(store.isUnlocked()).toBe(true);
    expect(readDeadmanState("personal")).toEqual(current);
  } finally {
    held.release();
    await old;
  }
});

it("a same-session disarm and replacement win over an older pending authentication signature", async () => {
  const { arm, setTime } = await armedStore();
  const held = holdSignature();
  setTime(1_790_000_001_000);
  const old = recordDeadmanAuthentication("personal");
  await held.started;
  try {
    await disarmDeadmanSwitch("personal");
    setTime(1_790_000_002_000);
    const id = await arm();
    const replacement = readDeadmanState("personal");
    held.release();
    await old;
    expect(readDeadmanState("personal")?.id).toBe(id);
    expect(readDeadmanState("personal")).toEqual(replacement);
  } finally {
    held.release();
    await old;
  }
});

it("disarming while a heartbeat is being signed prevents the stale relay send", async () => {
  const { fetch, setTime } = await armedStore();
  const held = holdSignature(2);
  setTime(1_790_000_001_000);
  const old = recordDeadmanAuthentication("personal");
  await held.started;
  try {
    await disarmDeadmanSwitch("personal");
    held.release();
    await old;
    expect(readDeadmanState("personal")).toBeNull();
    expect(
      fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).type),
    ).not.toContain("opensesame.deadman.heartbeat");
  } finally {
    held.release();
    await old;
  }
});
