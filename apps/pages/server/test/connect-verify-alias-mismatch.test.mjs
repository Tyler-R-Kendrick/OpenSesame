import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VERIFY_OAUTH_ALIAS_HOSTS,
  VERIFY_TARGETS,
} from "../connect-verify-targets.generated.mjs";
import { verifyTargetFor, verifyWithToken } from "../connect-verify.mjs";

const token = "synthetic-token-must-not-leave";

for (const [host, valid, mismatch, fallback] of [
  ["accounts.google.com", "google-drive", "m365", "google"],
  ["login.microsoftonline.com", "m365", "google-drive", "microsoft"],
]) {
  test(`${host} accepts a bound provider and retains unknown-UID fallback`, () => {
    assert.equal(
      verifyTargetFor({ service: host, uid: `${valid}/default`, data: {} }),
      VERIFY_TARGETS[valid].oauth,
    );
    assert.equal(
      verifyTargetFor({ service: host, uid: "unknown/default", data: {} }),
      VERIFY_TARGETS[fallback].oauth,
    );
  });

  test(`${host} refuses another known provider without sending its token`, async () => {
    const target = verifyTargetFor({
      service: host,
      uid: `${mismatch}/default`,
      data: {},
    });
    assert.equal(target, null);
    assert.equal(
      await verifyWithToken(target, token, () => assert.fail("must not fetch")),
      null,
    );
  });
}

test("a direct service ID still selects its own verified target", () => {
  assert.equal(
    verifyTargetFor({ service: "attio", uid: "attio/default", data: {} }),
    VERIFY_TARGETS.attio.oauth,
  );
});

for (const [service, uid] of [
  ["microsoft", "google-drive/default"],
  ["google-drive", "microsoft/default"],
  ["microsoft", "microsoft-teams/default"],
]) {
  test(`${service} refuses a different recognized UID without fetching`, async () => {
    const target = verifyTargetFor({ service, uid, data: {} });
    assert.equal(target, null);
    assert.equal(
      await verifyWithToken(target, token, () => assert.fail("must not fetch")),
      null,
    );
  });
}

test("unknown and custom UIDs retain direct service selection", () => {
  for (const uid of ["unlisted/default", "custom-uid", ""])
    assert.equal(
      verifyTargetFor({ service: "microsoft", uid, data: {} }),
      VERIFY_TARGETS.microsoft.oauth,
    );
});

test("generated host aliases cannot be modified by callers", () => {
  const aliases = VERIFY_OAUTH_ALIAS_HOSTS["login.microsoftonline.com"];
  assert.ok(Object.isFrozen(aliases));
  assert.throws(() => aliases.push("google-drive"), TypeError);
  assert.equal(
    verifyTargetFor({
      service: "login.microsoftonline.com",
      uid: "google-drive/default",
      data: {},
    }),
    null,
  );
});

test("generated service maps cannot substitute a verifier", async () => {
  assert.ok(Object.isFrozen(VERIFY_TARGETS.microsoft));
  assert.throws(() => {
    VERIFY_TARGETS.microsoft.oauth = {
      url: "https://attacker.example/collect",
    };
  }, TypeError);
  const target = verifyTargetFor({
    service: "microsoft",
    uid: "google-drive/default",
    data: {},
  });
  assert.equal(
    await verifyWithToken(target, token, () => assert.fail("must not fetch")),
    null,
  );
});
