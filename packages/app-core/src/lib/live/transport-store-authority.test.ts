import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  TRANSPORT_FILE,
  liveTransportFiles,
} from "../../sections/settings/live-transport-files.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { kvDelete, kvFlush, kvGet } from "../kv.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { PERSONAL_TOMB, tombFileKey } from "../vfs.js";
import { deferred } from "./live-clock.fixture.js";
import { transportReadiness } from "./transport-readiness.js";
import {
  TRANSPORT_PATH,
  TransportRefused,
  onTransportChange,
  readLiveTransport,
  storeSeams,
} from "./transport-store.js";

const RETIRED = "generated file-editor retired credential";
const TRANSPORT_KEY = tombFileKey(PERSONAL_TOMB, TRANSPORT_PATH);
const files = liveTransportFiles(() => PERSONAL_TOMB);
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const stops: (() => void)[] = [];

beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll(RETIRED, "synthetic_decoy");
  await files.write(TRANSPORT_FILE, "{}");
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  fixture.restore();
  clearActivePresentation();
  kvDelete(TRANSPORT_KEY);
  await kvFlush();
});

async function recover(synthetic: boolean) {
  fixture.store.lock();
  if (synthetic) {
    await expect(
      unlockWithRetiredCredentialGate(fixture.store, RETIRED),
    ).resolves.toBe("retired_credential_session");
    expect(fixture.store.getSnapshot().decoy).toBe(true);
    fixture.store.lock();
  }
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
    decoy: false,
  });
}

function heldCompletion() {
  const reached = deferred();
  const held = deferred();
  releases.push(held.release);
  return { reached, held };
}

it.each([false, true])(
  "refuses an unguarded queued file-editor write after fresh owner recovery (synthetic=%s)",
  async (synthetic) => {
    const { reached, held } = heldCompletion();
    const write = storeSeams.write;
    // Delay acknowledgment AFTER real encryption and persistence complete. The
    // VFS queue is clear, so fresh authentication really finishes before release.
    const dispatch = vi
      .spyOn(storeSeams, "write")
      .mockImplementationOnce(async (...args) => {
        await write(...args);
        reached.release();
        await held.promise;
      });
    const heard = vi.fn();
    stops.push(onTransportChange(heard));
    const first = files
      .write(TRANSPORT_FILE, '{"addresses":["100.64.0.1"]}')
      .catch((error: Error) => error);
    pending.push(first);
    await reached.promise;
    const before = kvGet(TRANSPORT_KEY);
    expect(before).not.toBeNull();
    const queued = files
      .write(TRANSPORT_FILE, '{"addresses":["100.64.0.2"]}')
      .catch((error: Error) => error);
    pending.push(queued);
    expect(transportReadiness().pending).toBe(2);
    await recover(synthetic);
    held.release();
    const result = await queued;
    expect(result).toBeInstanceOf(Error);
    expect(await first).toBeInstanceOf(Error);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(heard).not.toHaveBeenCalled();
    expect(kvGet(TRANSPORT_KEY)).toBe(before);
    expect(transportReadiness().pending).toBe(0);
    expect((await readLiveTransport(PERSONAL_TOMB)).addresses).toEqual([
      "100.64.0.1",
    ]);
    expect(
      await files.write(TRANSPORT_FILE, '{"addresses":["100.64.0.3"]}'),
    ).toEqual({ ok: true, path: TRANSPORT_FILE });
    expect((await readLiveTransport(PERSONAL_TOMB)).addresses).toEqual([
      "100.64.0.3",
    ]);
  },
);

it.each([
  ["refresh", false],
  ["refresh", true],
  ["read", false],
  ["read", true],
  ["absent", false],
  ["absent", true],
] as const)(
  "refuses a file-editor %s continuation after fresh owner recovery (synthetic=%s)",
  async (stage, synthetic) => {
    const { reached, held } = heldCompletion();
    if (stage === "absent") kvDelete(TRANSPORT_KEY);
    const refresh = storeSeams.refresh;
    const read = storeSeams.read;
    if (stage === "refresh") {
      vi.spyOn(storeSeams, "refresh").mockImplementationOnce(
        async (...args) => {
          reached.release();
          await held.promise;
          await refresh(...args);
        },
      );
    } else {
      vi.spyOn(storeSeams, "read").mockImplementationOnce(async (...args) => {
        const result = await read(...args).then(
          (bytes) => ({ bytes }),
          (error: Error) => ({ error }),
        );
        reached.release();
        await held.promise;
        if ("error" in result) throw result.error;
        return result.bytes;
      });
    }
    const stale = files.read(TRANSPORT_FILE).then(
      (value) => value,
      (error: Error) => error,
    );
    pending.push(stale);
    await reached.promise;
    await recover(synthetic);
    await files.write(TRANSPORT_FILE, '{"addresses":["100.64.0.4"]}');
    const before = kvGet(TRANSPORT_KEY);
    held.release();
    expect(await stale).toBeInstanceOf(Error);
    expect(kvGet(TRANSPORT_KEY)).toBe(before);
    expect(JSON.parse(await files.read(TRANSPORT_FILE))).toMatchObject({
      addresses: ["100.64.0.4"],
    });
    expect(transportReadiness().pending).toBe(0);
  },
);

it("refuses a parsed-profile read when the real owner locks after the sealed text completes", async () => {
  await files.write(
    TRANSPORT_FILE,
    '{"addresses":["100.64.0.4"],"ice":[{"urls":"turn:relay.example","username":"owner","credential":"owner-turn-secret"}]}',
  );
  const before = kvGet(TRANSPORT_KEY);
  const read = storeSeams.read;
  vi.spyOn(storeSeams, "read").mockImplementationOnce(async (...args) => {
    const bytes = await read(...args);
    // The sealed-text continuation completes first; the public parsed-profile
    // continuation must still retain the original owner's authority.
    queueMicrotask(() => queueMicrotask(() => fixture.store.lock()));
    return bytes;
  });
  const stale = await readLiveTransport(PERSONAL_TOMB).catch(
    (error: Error) => error,
  );
  expect(fixture.store.getSnapshot().status).toBe("locked");
  expect(stale).toBeInstanceOf(TransportRefused);
  expect(kvGet(TRANSPORT_KEY)).toBe(before);
  await fixture.store.unlock(PASSWORD);
  expect((await readLiveTransport(PERSONAL_TOMB)).ice).toEqual([
    {
      urls: ["turn:relay.example"],
      username: "owner",
      credential: "owner-turn-secret",
    },
  ]);
});
