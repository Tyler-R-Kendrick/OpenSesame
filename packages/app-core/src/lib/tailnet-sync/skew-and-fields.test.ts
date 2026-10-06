/**
 * Two devices whose clocks disagree, and two devices that edit different
 * fields of one item (ADR 0144), end to end through the store and a drive.
 * The store stamps every local edit after everything its vault has seen, and
 * records which fields it changed, so neither case loses a write.
 */
import {
  type AccountItem,
  accountTotp,
  createItem,
  manualPassword,
  passwordMethod,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptSnapshot } from "./adopt.js";
import { type Device, as, device } from "./devices.fixture.js";
import { type MemoryDrive, PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";

const PASSWORD = "correct horse battery staple";
const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const HOUR = 3_600_000;

function sync(on: Device, drive: MemoryDrive) {
  return as(on, () => syncOnce(on.store, PAIRING, drive));
}

function login(on: Device, id: string): AccountItem {
  const item = on.store.getSnapshot().items.find((entry) => entry.id === id);
  if (item?.kind !== "account") throw new Error(`no account ${id}`);
  return item;
}

/** What the account's password method stores: the field the merge carries. */
function storedPassword(item: AccountItem): string | undefined {
  return passwordMethod(item)?.secret;
}

/** The account with its password method's secret replaced. */
function withPassword(item: AccountItem, secret: string): AccountItem {
  return {
    ...item,
    methods: item.methods.map((method) =>
      method.type === "password" ? { ...method, secret } : method,
    ),
  };
}

/** A laptop with one login, paired; a phone set up from the drive. */
async function pairedDevices() {
  const drive = memoryDrive();
  const laptop = device("laptop");
  const phone = device("phone");
  const created = createItem("account", "Bank");
  if (created.kind !== "account") throw new Error("not an account");
  // A password the person typed: what a merge carries as a stored field.
  const bank: AccountItem = {
    ...created,
    methods: [
      manualPassword(`${created.id}:password`, "first", created.createdAt),
    ],
    username: "ada",
  };
  await as(laptop, async () => {
    await laptop.store.create(PASSWORD);
    await laptop.store.saveItem(bank);
  });
  await sync(laptop, drive);
  const snapshot = drive.snapshot;
  if (!snapshot) throw new Error("the laptop did not fill the drive");
  await as(phone, async () => {
    expect(await adoptSnapshot(snapshot)).toBe("adopted");
    phone.store.rehydrate();
    await phone.store.unlock(PASSWORD);
  });
  return { drive, laptop, phone, id: bank.id };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a device whose clock runs behind", () => {
  it("still wins with an edit it made after seeing the other's", async () => {
    const { drive, laptop, phone, id } = await pairedDevices();

    // The laptop's clock is an hour fast when it changes the password.
    vi.setSystemTime(NOW + HOUR);
    await as(laptop, () =>
      laptop.store.saveItem(withPassword(login(laptop, id), "second")),
    );
    await sync(laptop, drive);

    // The phone, on the right time, sees that and then changes it again.
    vi.setSystemTime(NOW + 60_000);
    await sync(phone, drive);
    expect(storedPassword(login(phone, id))).toBe("second");
    await as(phone, () =>
      phone.store.saveItem(withPassword(login(phone, id), "third")),
    );
    // Stamped after the laptop's fast clock, not at the phone's own time.
    expect(login(phone, id).updatedAt > login(laptop, id).updatedAt).toBe(true);
    await sync(phone, drive);
    await sync(laptop, drive);

    expect(storedPassword(login(laptop, id))).toBe("third");
    expect(storedPassword(login(phone, id))).toBe("third");
  });

  it("keeps an item it purged gone, even one a fast clock stamped", async () => {
    const { drive, laptop, phone, id } = await pairedDevices();
    vi.setSystemTime(NOW + HOUR);
    await as(laptop, () =>
      laptop.store.saveItem({ ...login(laptop, id), notes: "fast" }),
    );
    await sync(laptop, drive);

    vi.setSystemTime(NOW + 60_000);
    await sync(phone, drive);
    await as(phone, async () => {
      await phone.store.trashItem(id);
      await phone.store.purgeItem(id);
    });
    await sync(phone, drive);
    await sync(laptop, drive);

    for (const on of [laptop, phone]) {
      expect(on.store.getSnapshot().items.map((item) => item.id)).not.toContain(
        id,
      );
    }
  });
});

describe("two devices editing one item", () => {
  it("keeps both devices' changes to different fields", async () => {
    const { drive, laptop, phone, id } = await pairedDevices();

    vi.setSystemTime(NOW + 60_000);
    await as(laptop, () =>
      laptop.store.saveItem({ ...login(laptop, id), notes: "Call first" }),
    );
    vi.setSystemTime(NOW + 120_000);
    await as(phone, () =>
      phone.store.saveItem({ ...login(phone, id), username: "ada@bank" }),
    );

    await sync(laptop, drive);
    await sync(phone, drive);
    await sync(laptop, drive);

    for (const on of [laptop, phone]) {
      const merged = login(on, id);
      expect(merged.notes).toBe("Call first");
      expect(merged.username).toBe("ada@bank");
      expect(storedPassword(merged)).toBe("first");
    }
    expect(JSON.stringify(login(laptop, id))).toBe(
      JSON.stringify(login(phone, id)),
    );
    // Settled: another round moves nothing.
    expect(await sync(laptop, drive)).toMatchObject({ pushed: false });
    expect(await sync(phone, drive)).toMatchObject({
      pulled: false,
      pushed: false,
    });
  });

  it("keeps a password changed here and an authenticator added there", async () => {
    const { drive, laptop, phone, id } = await pairedDevices();

    vi.setSystemTime(NOW + 60_000);
    await as(laptop, () =>
      laptop.store.saveItem(withPassword(login(laptop, id), "second")),
    );
    vi.setSystemTime(NOW + 120_000);
    await as(phone, () => {
      const item = login(phone, id);
      return phone.store.saveItem({
        ...item,
        methods: [
          ...item.methods,
          {
            id: `${id}:authenticator`,
            type: "authenticator",
            secret: "JBSWY3DP",
          },
        ],
      });
    });

    await sync(laptop, drive);
    await sync(phone, drive);
    await sync(laptop, drive);

    for (const on of [laptop, phone]) {
      expect(storedPassword(login(on, id))).toBe("second");
      expect(accountTotp(login(on, id))).toBe("JBSWY3DP");
    }
  });
});
