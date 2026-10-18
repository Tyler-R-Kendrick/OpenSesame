import { afterEach, expect, it } from "vitest";
import {
  type BitwardenNativeAccount,
  openBitwardenNativeAccount,
} from "./bitwarden-native-account.js";
import {
  createBitwardenBlobItem,
  readBitwardenBlobItem,
  updateBitwardenBlobItem,
} from "./bitwarden-native-blob-item.js";
import { bitwardenCborMap } from "./bitwarden-native-cose.js";
import {
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "./bitwarden-native-http.test-support.js";
import { nativeText } from "./bitwarden-native-item.js";
import {
  createBitwardenLegacyItem,
  readBitwardenLegacyItem,
  updateBitwardenLegacyItem,
} from "./bitwarden-native-legacy-item.js";
import type { SecretBackendItemInput } from "./types.js";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
const fixtures: Fixture[] = [];
const accounts: BitwardenNativeAccount[] = [];
const input: SecretBackendItemInput = {
  kind: "login",
  name: "Owned native HTTP 🔐",
  notes: "Owned confidential note",
  secret: "Owned confidential password",
  username: "owner",
  url: "https://owned.example.test",
};
afterEach(async () => {
  for (const account of accounts.splice(0)) account.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function connected(modern: boolean) {
  const fixture = await nativeHttpFixture(modern);
  fixtures.push(fixture);
  const account = await openBitwardenNativeAccount(
    fixture.credentials,
    NATIVE_PASSWORD,
    NATIVE_LIMITS,
    fixture.transport,
  );
  accounts.push(account);
  return { fixture, account };
}
it.each([false, true])(
  "executes actual encrypted native personal create/read/sync/update/trash over HTTP modern=%s",
  async (modern) => {
    const { fixture, account } = await connected(modern);
    const create = modern ? createBitwardenBlobItem : createBitwardenLegacyItem;
    const read = modern ? readBitwardenBlobItem : readBitwardenLegacyItem;
    const edit = modern ? updateBitwardenBlobItem : updateBitwardenLegacyItem;
    const created = await account.ciphers.create(create(input, account.key));
    const id = nativeText(created.id);
    const plain = fixture.decoded.get(id);
    expect(plain?.get("name")).toBe(input.name);
    expect(plain?.get("notes")).toBe(input.notes);
    expect(read(await account.ciphers.get(id), account.key)).toMatchObject({
      ...input,
      id,
    });
    expect(await account.sync()).toHaveLength(1);
    const stored = fixture.items.get(id);
    if (!stored) throw new Error("Missing independently stored item.");
    stored.unknownMetadata = { keep: [1, "future"] };
    const current = await account.ciphers.get(id);
    const replacement = {
      ...input,
      name: "Updated through native HTTP",
      secret: "Replacement confidential password",
    };
    const updated = await account.ciphers.update(
      id,
      edit(current, replacement, account.key),
    );
    expect(read(updated, account.key)).toMatchObject({ ...replacement, id });
    expect(updated.key).toBe(created.key);
    expect(updated.unknownMetadata).toEqual(stored.unknownMetadata);
    const decoded = fixture.decoded.get(id);
    const password = modern
      ? bitwardenCborMap(decoded?.get("typeData")).get("password")
      : decoded?.get("password");
    expect(password).toBe(replacement.secret);
    const writes = fixture.requests.filter(
      (request) =>
        request.path.startsWith("/api/ciphers") && request.method !== "GET",
    );
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.body).not.toContain(input.notes);
      expect(write.body).not.toContain(replacement.secret);
      expect(write.body).not.toContain(NATIVE_PASSWORD);
    }
    expect(JSON.parse(writes[1].body).lastKnownRevisionDate).toBe(
      current.revisionDate,
    );
    fixture.state.emptyTrash200 = !modern;
    await account.ciphers.trash(id);
    const synced = await account.sync();
    expect(synced).toHaveLength(1);
    expect(fixture.items.get(id)?.deletedDate).toBeDefined();
  },
);
it("rejects stale revisions at the owned provider and never replays mutation HTTP401", async () => {
  const { fixture, account } = await connected(false);
  const wire = await account.ciphers.create(
    createBitwardenLegacyItem(input, account.key),
  );
  const id = nativeText(wire.id);
  const stale = updateBitwardenLegacyItem(
    wire,
    { ...input, notes: "stale update" },
    account.key,
  );
  stale.revisionDate = "2020-01-01T00:00:00Z";
  await expect(account.ciphers.update(id, stale)).rejects.toMatchObject({
    status: 400,
  });
  expect(fixture.decoded.get(id)?.get("notes")).toBe(input.notes);
  fixture.state.rejectWrites = true;
  const count = fixture.requests.length;
  await expect(
    account.ciphers.create(createBitwardenLegacyItem(input, account.key)),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    fixture.requests
      .slice(count)
      .filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter((request) =>
      request.path.endsWith("connect/token"),
    ),
  ).toHaveLength(1);
});
it("rejects ID mismatch responses and path escapes before accepting or dispatching operations", async () => {
  const { fixture, account } = await connected(false);
  const row = await account.ciphers.create(
    createBitwardenLegacyItem(input, account.key),
  );
  const id = nativeText(row.id);
  fixture.state.wrongId = true;
  await expect(account.ciphers.get(id)).rejects.toMatchObject({
    code: "response",
  });
  const count = fixture.requests.length;
  await expect(account.ciphers.get("../sync")).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fixture.requests).toHaveLength(count);
});
it("rejects a held write after withdrawal and does not accept a late provider result or replay it", async () => {
  const { fixture, account } = await connected(true);
  const held = fixture.hold("/api/ciphers", "POST");
  const material = account.key.material;
  const creating = account.ciphers.create(
    createBitwardenBlobItem(input, account.key),
  );
  await held.ready;
  fixture.controller.abort();
  await expect(creating).rejects.toBeDefined();
  expect(material.every((byte) => byte === 0)).toBe(true);
  held.release();
  expect(
    fixture.requests.filter((request) => request.path === "/api/ciphers"),
  ).toHaveLength(1);
});
