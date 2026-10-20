import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvForgetAll, kvSet } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import { lockAllTombs } from "../vfs.js";
import {
  commitDeadmanSwitch,
  deadmanSeams,
  deadmanStateKey,
  deadmanStatusForUnlock,
  disarmDeadmanSwitch,
  loadDeadmanRelease,
  prepareDeadmanSwitch,
  readDeadmanState,
  recordDeadmanAuthentication,
  releaseDeadmanSwitch,
} from "./index.js";

const PASSWORD = "correct horse battery staple";
const DAY = 86_400_000;
const T0 = 1_790_000_000_000;

const originalNow = deadmanSeams.now;
let store: VaultStore;
let tomb: string;

beforeEach(async () => {
  kvForgetAll();
  lockAllTombs();
  deadmanSeams.now = () => T0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200 }) as Response),
  );
  store = new VaultStore();
  await store.create(PASSWORD);
  tomb = store.getSnapshot().tomb;
});

afterEach(async () => {
  store.lock();
  kvForgetAll();
  lockAllTombs();
  deadmanSeams.now = originalNow;
  vi.unstubAllGlobals();
  kvDelete("settings.v1");
});

function note(name: string, body: string) {
  const item = createItem("note", name);
  item.notes = body;
  return item;
}

async function arm() {
  const item = note("Instructions", "The spare key is under the blue tile.");
  const plan = await prepareDeadmanSwitch({
    tomb,
    items: [item],
    itemIds: [item.id],
    timeoutDays: 30,
    relayUrl: "https://relay.example.test/deadman",
    webhookUrl: "https://agent.example.test/deadman",
    relayToken: "relay-token",
  });
  await commitDeadmanSwitch(plan);
  return { item, plan };
}

describe("deadman switch", () => {
  it("refuses to release before the deadline and opens the package after it", async () => {
    const { plan } = await arm();
    expect(readDeadmanState(tomb)?.lastAuthenticatedAt).toBe(T0);
    expect(deadmanStatusForUnlock(tomb)?.triggered).toBe(false);

    await expect(loadDeadmanRelease(tomb)).rejects.toThrow(/deadline/i);

    deadmanSeams.now = () => T0 + 31 * DAY;
    expect(deadmanStatusForUnlock(tomb)?.triggered).toBe(true);
    const release = await loadDeadmanRelease(tomb);
    expect(release.package.itemCount).toBe(1);
    const items = await releaseDeadmanSwitch(tomb, plan.releaseKey);
    expect(items[0]?.notes).toBe("The spare key is under the blue tile.");

    await expect(
      releaseDeadmanSwitch(
        tomb,
        "osdm1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    ).rejects.toThrow(/did not open|release key|characters/i);
  });

  it("refuses a local record whose signed deadline was edited", async () => {
    await arm();
    deadmanSeams.now = () => T0 + 31 * DAY;
    const current = readDeadmanState(tomb);
    if (!current) throw new Error("expected a deadman record");
    kvSet(
      deadmanStateKey(tomb),
      JSON.stringify({ ...current, lastAuthenticatedAt: 0 }),
    );
    await expect(loadDeadmanRelease(tomb)).rejects.toThrow(/did not verify/i);
  });

  it("moves the deadline on the next authenticated unlock", async () => {
    const { plan } = await arm();
    deadmanSeams.now = () => T0 + 31 * DAY;
    expect(deadmanStatusForUnlock(tomb)?.triggered).toBe(true);
    await recordDeadmanAuthentication(tomb);
    expect(readDeadmanState(tomb)?.lastAuthenticatedAt).toBe(T0 + 31 * DAY);
    expect(deadmanStatusForUnlock(tomb)?.triggered).toBe(false);
    await expect(releaseDeadmanSwitch(tomb, plan.releaseKey)).rejects.toThrow(
      /deadline/i,
    );
  });

  it("does not arm if the relay refuses the signed arm", async () => {
    const item = note("Instructions", "not sent");
    const plan = await prepareDeadmanSwitch({
      tomb,
      items: [item],
      itemIds: [item.id],
      timeoutDays: 7,
      relayUrl: "https://relay.example.test/deadman",
      webhookUrl: "https://agent.example.test/deadman",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }) as Response),
    );
    await expect(commitDeadmanSwitch(plan)).rejects.toThrow(/503/);
    expect(readDeadmanState(tomb)).toBeNull();
  });

  it("disarms only after the relay accepts and removes the local package", async () => {
    await arm();
    await disarmDeadmanSwitch(tomb);
    expect(readDeadmanState(tomb)).toBeNull();
    expect(deadmanStatusForUnlock(tomb)).toBeNull();
  });
});
