/** Real provider sockets and independent encryption oracle, not a browser/Worker proof. */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { NATIVE_LIMITS } from "../../../../packages/app-core/src/lib/secret-backends/bitwarden-native-http.test-support.ts";
import { createBitwardenNativeBackend } from "../../../../packages/app-core/src/lib/secret-backends/bitwarden-native.ts";
import { secretBackendDraft } from "../../../../packages/app-core/src/lib/secret-backends/presets.ts";
import { validateSecretBackendDraft } from "../../../../packages/app-core/src/lib/secret-backends/schema.ts";
import { startBitwardenFixture } from "./secret-backend-bitwarden-fixture.mjs";

const ORIGIN = "http://localhost:41901";
const closes = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const target = await startBitwardenFixture(ORIGIN, 0);
  closes.push(target.close);
  return target;
}
function configuration(target) {
  return {
    ...secretBackendDraft("bitwarden"),
    ...target.credentials,
    name: target.name,
    accountEmail: target.credentials.email,
    masterPassword: target.password,
  };
}
function backend(target) {
  const owner = new AbortController();
  const transport = {
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", ORIGIN);
      return fetch(input, { ...init, headers });
    },
  };
  closes.push(async () => owner.abort());
  return createBitwardenNativeBackend(transport, NATIVE_LIMITS);
}
test("the original incomplete input is refused while native account fields normalize without a master password", async () => {
  const target = await fixture();
  const original = {
    ...secretBackendDraft("bitwarden"),
    baseUrl: target.origin,
  };
  assert.throws(() => validateSecretBackendDraft(original));
  const valid = validateSecretBackendDraft(configuration(target));
  assert.equal(valid.mode, "bitwarden-api");
  assert.equal(Object.hasOwn(valid, "masterPassword"), false);
  assert.equal(valid.accountEmail, target.credentials.email);
});
test("only the declared browser origin and native API preflight methods are admitted", async () => {
  const target = await fixture();
  const request = async (origin, method) =>
    fetch(`${target.origin}/api/sync?excludeDomains=true`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "authorization,content-type,accept",
      },
    });
  const accepted = await request(ORIGIN, "PUT");
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal((await request("http://other.example", "PUT")).status, 403);
  assert.equal((await request(ORIGIN, "DELETE")).status, 403);
  assert.equal(target.wire.length, 0);
});
test("common native personal-account note/login/secret CRUD crosses real HTTP as ciphertext and trashes through PUT", async () => {
  const target = await fixture();
  const port = backend(target);
  const session = await port.authenticate(configuration(target));
  closes.push(() => port.disconnect(session));
  for (const kind of ["note", "login", "secret"]) {
    const input = {
      kind,
      name: `Native ${kind}`,
      notes: "Confidential notes",
      secret: "Confidential password",
      username: "fixture-user",
      url: "https://owned.example",
    };
    const created = await port.createItem(input, session);
    assert.equal((await port.getItem(created.id, session)).name, input.name);
    assert.equal(await port.getNotes(created.id, session), input.notes);
    assert.equal(target.decoded.get(created.id).get("notes"), input.notes);
    await port.updateItem(
      created.id,
      { ...input, notes: "Changed notes" },
      session,
    );
    assert.equal(await port.getNotes(created.id, session), "Changed notes");
    assert.equal((await port.listItems(session)).length, 1);
    await port.deleteItem(created.id, session);
    assert.equal((await port.listItems(session)).length, 0);
    assert(target.items.get(created.id).deletedDate);
  }
  const writes = target.wire.filter(
    (row) => row.path.startsWith("/api/ciphers") && row.method !== "GET",
  );
  assert.equal(
    writes.filter((row) => row.path.endsWith("/delete") && row.method === "PUT")
      .length,
    3,
  );
  for (const row of writes)
    for (const privateValue of [
      target.password,
      target.credentials.clientSecret,
      "Confidential notes",
      "Confidential password",
      "Changed notes",
    ])
      assert(!row.body.includes(privateValue));
  assert(
    target.requests.every(
      (row) => row.originAllowed && (row.credentialValid || row.publicPrelogin),
    ),
  );
  assert.equal(
    target.requests.some(
      (row) => row.path === "/status" || row.path.startsWith("/object/"),
    ),
    false,
  );
  assert.deepEqual(target.errors, []);
});
test("bad API credentials and a bad local master password never authorize item mutations", async () => {
  const target = await fixture();
  const port = backend(target);
  await assert.rejects(
    port.authenticate({
      ...configuration(target),
      clientSecret: "wrong-api-secret",
    }),
  );
  await assert.rejects(
    port.authenticate({
      ...configuration(target),
      masterPassword: "wrong-master-password",
    }),
  );
  assert.equal(
    target.wire.some((row) => row.path.startsWith("/api/ciphers")),
    false,
  );
  assert(
    target.wire.every(
      (row) =>
        !row.body.includes(target.password) &&
        !row.body.includes("wrong-master-password"),
    ),
  );
  assert.deepEqual(target.errors, []);
});
test("provider facade shutdown is idempotent and closes its original listener", async () => {
  const target = await fixture();
  await target.close();
  await target.close();
  await assert.rejects(
    fetch(target.origin, { signal: AbortSignal.timeout(1000) }),
  );
});
