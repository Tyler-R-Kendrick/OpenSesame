/** Pure, deterministic rules for artifacts obtainable by the same observer. */
import { isJsonObject, isString } from "./json-boundary.mjs";
export const POLICY_PATH = "tools/security/exposure-matrix.json";
export const digestPattern = /^[a-f0-9]{64}$/u;
import { CORE_CONTRACTS } from "./exposure-contracts.mjs";
export const REQUIRED_SURFACES = Object.freeze(
  Object.fromEntries(
    Object.entries(CORE_CONTRACTS).map(([id, contract]) => [id, contract.kind]),
  ),
);

const OBSERVERS = [
  "public",
  "link-holder",
  "authenticated",
  "authorized-recipient",
  "device-owner",
  "network-peer",
];
const ARTIFACTS = [
  "public-key",
  "public-certificate",
  "private-key",
  "raw-secret",
  "ciphertext",
  "payload-key",
  "otp-seed",
  "code-verifier",
  "guess-oracle",
  "authority-api",
  "certificate-binding",
];
const CONTROLS = [
  "mandatory-proof",
  "bearer-before-budget",
  "trusted-budget-source",
  "validated-budget-owner",
  "owner-isolated-capacity",
  "code-derived-aead",
  "bounded-kdf",
  "cryptographic-random",
  "public-parameter-allowlist",
  "explicit-export-grant",
  "recipient-bound",
  "step-up",
  "all-listeners-classified",
  "explicit-network-bind",
  "joined-listener-lifetime",
  "preserve-policy-on-omission",
  "originating-client-proof",
  "exact-bootstrap-trust",
  "confined-import-paths",
  "bounded-import-input",
  "pinned-import-origin",
];
const GUARANTEES = ["single-use", "expiry", "revocation"];
const VERIFICATIONS = [
  "server",
  "code-aead",
  "signature",
  "client-only",
  "none",
];
const ENFORCEMENT = ["authoritative", "advisory", "none"];
const SURFACE_FIELDS = [
  "id",
  "kind",
  "area",
  "flow",
  "observer",
  "artifacts",
  "verification",
  "controls",
  "guarantees",
  "enforcement",
  "entropyBits",
  "minSecretBytes",
  "budget",
  "implementation",
  "regressions",
  "review",
];

const fail = (message) => {
  throw new Error(`EM-SCHEMA: ${message}`);
};
const text = (value) => isString(value) && value.trim().length > 0;
const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) fail(`unsupported ${name}`);
};

function keys(value, allowed, name) {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${name} has missing or unknown fields`);
  }
}

function stringList(value, name, allowed) {
  if (
    !Array.isArray(value) ||
    value.some((item) => !text(item)) ||
    new Set(value).size !== value.length
  )
    fail(`invalid ${name}`);
  if (allowed && value.some((item) => !allowed.includes(item)))
    fail(`unknown ${name}`);
}

export function validSourcePath(path) {
  return (
    text(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\0\r\n]/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function sourceList(value, name) {
  stringList(value, name);
  if (value.length === 0 || value.some((path) => !validSourcePath(path)))
    fail(`empty or unsafe ${name}`);
}

function budget(value) {
  if (value === null) return;
  keys(
    value,
    [
      "scope",
      "limit",
      "windowSeconds",
      "storage",
      "admission",
      "atomicity",
      "eviction",
      "sharing",
    ],
    "budget",
  );
  oneOf(
    value.scope,
    [
      "account",
      "claim",
      "profile",
      "profile-source",
      "send",
      "api-key",
      "device",
      "activation",
      "ip",
      "global",
    ],
    "budget scope",
  );
  oneOf(value.storage, ["durable", "process-local"], "budget storage");
  oneOf(
    value.admission,
    ["before-verification", "after-verification"],
    "budget admission",
  );
  oneOf(value.atomicity, ["atomic", "read-then-write"], "budget atomicity");
  oneOf(value.eviction, ["expired-only", "live-eviction"], "budget eviction");
  oneOf(value.sharing, ["across-routes", "per-route"], "budget sharing");
  if (
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 20 ||
    !Number.isSafeInteger(value.windowSeconds) ||
    value.windowSeconds < 1 ||
    value.windowSeconds > 86400
  )
    fail("invalid budget bounds");
}

function surface(value) {
  keys(value, SURFACE_FIELDS, "surface");
  for (const field of ["id", "area", "flow", "review"])
    if (!text(value[field])) fail(`missing ${field}`);
  if (!/^[a-z][a-z0-9-]*$/u.test(value.id)) fail("invalid surface id");
  oneOf(
    value.kind,
    [...new Set(Object.values(REQUIRED_SURFACES))],
    "surface kind",
  );
  oneOf(value.observer, OBSERVERS, "observer");
  oneOf(value.verification, VERIFICATIONS, "verification");
  oneOf(value.enforcement, ENFORCEMENT, "enforcement");
  stringList(value.artifacts, "artifacts", ARTIFACTS);
  stringList(value.controls, "controls", CONTROLS);
  stringList(value.guarantees, "guarantees", GUARANTEES);
  sourceList(value.implementation, "implementation bindings");
  sourceList(value.regressions, "regression bindings");
  if (
    value.regressions.some(
      (path) =>
        !/(?:\.test\.[cm]?[jt]sx?$|_tests?(?:_[^/]+)?\.rs$|\/tests\/.+\.rs$|\/tests\.rs$)/u.test(
          path,
        ),
    )
  )
    fail("regressions must name test sources");
  for (const field of ["entropyBits", "minSecretBytes"])
    if (
      !Number.isSafeInteger(value[field]) ||
      value[field] < 0 ||
      value[field] > 4096
    )
      fail(`invalid ${field}`);
  budget(value.budget);
}

function requiredBoundaries(surfaces) {
  for (const [id, contract] of Object.entries(CORE_CONTRACTS)) {
    const row = surfaces.find((item) => item.id === id);
    if (!row) fail(`required boundary ${id} is absent`);
    for (const field of ["kind", "observer", "area", "flow", "verification"]) {
      if (contract[field] !== undefined && row[field] !== contract[field])
        fail(`required ${field} for ${id} cannot be weakened or detached`);
    }
    for (const artifact of contract.artifacts ?? []) {
      if (!row.artifacts.includes(artifact))
        fail(`required artifact for ${id} cannot be hidden`);
    }
  }
}

/** Strict policy input, with a non-removable core set of reviewed boundaries. */
export function validatePolicy(value) {
  keys(value, ["version", "surfaces", "sources"], "matrix");
  if (
    value.version !== 1 ||
    !Array.isArray(value.surfaces) ||
    !isJsonObject(value.sources)
  )
    fail("unsupported matrix version or shape");
  const ids = new Set();
  for (const row of value.surfaces) {
    surface(row);
    if (ids.has(row.id)) fail(`duplicate surface ${row.id}`);
    ids.add(row.id);
  }
  requiredBoundaries(value.surfaces);
  const used = new Set(
    value.surfaces.flatMap((row) => [
      ...row.implementation,
      ...row.regressions,
    ]),
  );
  for (const [path, hash] of Object.entries(value.sources)) {
    if (!validSourcePath(path) || !digestPattern.test(hash) || !used.has(path))
      fail(`unsafe, unbound or invalid source ${JSON.stringify(path)}`);
  }
  for (const path of used)
    if (!Object.hasOwn(value.sources, path))
      fail(`missing source fingerprint ${path}`);
  return value;
}

/** JSON's last-key-wins behavior must not hide contradictory policy entries. */
export function parsePolicy(bytes) {
  if (bytes.byteLength > 4 * 1024 * 1024) fail("matrix exceeds size bound");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(raw);
  const stack = [];
  for (const [token] of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/gu)) {
    if (token === "{" || token === "[") {
      stack.push({
        object: token === "{",
        expectingKey: true,
        keys: new Set(),
      });
      if (stack.length > 100) fail("matrix nesting exceeds bound");
    } else if (token === "}" || token === "]") stack.pop();
    else {
      const frame = stack.at(-1);
      if (!frame?.object) continue;
      if (token === ",") frame.expectingKey = true;
      else if (token === ":") frame.expectingKey = false;
      else if (frame.expectingKey && token.startsWith('"')) {
        const key = JSON.parse(token);
        if (frame.keys.has(key)) fail("duplicate JSON property");
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    }
  }
  return validatePolicy(value);
}

export { exposureViolations } from "./exposure-rules.mjs";
