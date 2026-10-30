import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  exposureViolations,
  parsePolicy,
  validatePolicy,
} from "../lib/exposure-policy.mjs";

const baseline = parsePolicy(
  readFileSync(
    new URL("../../tools/security/exposure-matrix.json", import.meta.url),
  ),
);
const check = (value) => exposureViolations(validatePolicy(value));
const row = (value, id) => value.surfaces.find((surface) => surface.id === id);

test("EST source isolation is an explicit long-credential contract", () => {
  assert.deepEqual(check(baseline), []);
  assert.equal(row(baseline, "est-password").budget.scope, "profile-source");
});

for (const scope of ["profile", "ip", "account", "global"]) {
  test(`EST cannot substitute the ${scope} scope for its reviewed partition`, () => {
    const value = structuredClone(baseline);
    row(value, "est-password").budget.scope = scope;
    assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-SCOPE"));
  });
}

test("caller-selected or unbound EST source labels are not sufficient", () => {
  const value = structuredClone(baseline);
  const est = row(value, "est-password");
  est.controls = est.controls.filter(
    (control) => control !== "trusted-budget-source",
  );
  assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-SOURCE"));
});

test("a source partition cannot justify a short EST secret", () => {
  const value = structuredClone(baseline);
  row(value, "est-password").minSecretBytes = 6;
  assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-SOURCE"));
});

test("a short account code cannot borrow EST's source partition", () => {
  const value = structuredClone(baseline);
  const account = row(value, "account-totp");
  account.budget.scope = "profile-source";
  account.controls.push("trusted-budget-source");
  assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-SOURCE"));
  assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-SCOPE"));
});

for (const id of [
  "bitwarden-account",
  "bitwarden-send",
  "bitwarden-api-key",
  "bitwarden-device-code",
]) {
  test(`${id} requires validated owners before budget allocation`, () => {
    const value = structuredClone(baseline);
    const surface = row(value, id);
    surface.controls = surface.controls.filter(
      (control) => control !== "validated-budget-owner",
    );
    assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-OWNER"));
  });
  test(`${id} cannot exhaust unrelated owners through shared capacity`, () => {
    const value = structuredClone(baseline);
    const surface = row(value, id);
    surface.controls = surface.controls.filter(
      (control) => control !== "owner-isolated-capacity",
    );
    assert.ok(check(value).some((entry) => entry.rule === "EM-BUDGET-OWNER"));
  });
}
