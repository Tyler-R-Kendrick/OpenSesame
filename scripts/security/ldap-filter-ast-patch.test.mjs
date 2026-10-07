import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const reference = createRequire(
  path.join(root, "tools/mock-upstream-idp/package.json"),
);
const ldap = reference("ldapjs");
const vendor = createRequire(reference.resolve("ldapjs"));
const messages = vendor("@ldapjs/messages");
const { BerReader } = vendor("@ldapjs/asn1");
const { parse } = createRequire(
  path.join(root, "node_modules/.pnpm/node_modules/"),
)("yaml");
const family = "@ldapjs/messages";
const version = "1.3.0";
const key = `${family}@${version}`;
const filters = ldap.filters;

function transmitted(filter) {
  return new messages.SearchRequest({
    baseObject: "dc=outcomes,dc=example",
    filter,
    scope: messages.SearchRequest.SCOPE_SUBTREE,
  });
}

function roundtrip(filter) {
  return messages.LdapMessage.parse(transmitted(filter).toBer());
}

function consumersArePatched(lock, expected) {
  const consumers = [
    ...Object.values(lock.importers),
    ...Object.values(lock.snapshots),
  ];
  let count = 0;
  for (const consumer of consumers) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, value] of Object.entries(consumer[field] ?? {})) {
        if (name !== family) continue;
        assert.equal(
          typeof value === "string" ? value : value.version,
          expected,
        );
        count++;
      }
    }
  }
  assert.ok(count > 0);
}

test("the real reference library uses the exact generated patch binding on every messages edge", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const binding = lock.patchedDependencies[key];
  assert.equal(binding.path, "patches/@ldapjs__messages@1.3.0.patch");
  assert.equal(manifest.pnpm.patchedDependencies[key], binding.path);
  assert.match(binding.hash, /^[a-z0-9]+$/);
  const patch = readFileSync(path.join(root, binding.path), "utf8");
  assert.deepEqual(
    patch.split("\n").filter((line) => /^[+-](?![+-])/.test(line)),
    ["-      filter: parsedFilter.toString(),", "+      filter: parsedFilter,"],
  );
  const headers = patch
    .split("\n")
    .filter((line) => line.startsWith("diff --git "));
  assert.deepEqual(headers, [
    "diff --git a/lib/messages/search-request.js b/lib/messages/search-request.js",
  ]);
  const expected = `${version}(patch_hash=${binding.hash})`;
  assert.ok(lock.snapshots[`${family}@${expected}`]);
  assert.equal(lock.snapshots[key], undefined);
  consumersArePatched(lock, expected);
  const installed = realpathSync(vendor.resolve(`${family}/package.json`));
  assert.ok(
    installed.endsWith(
      `@ldapjs+messages@${version}_patch_hash=${binding.hash}/node_modules/${family}/package.json`,
    ),
  );
  const source = readFileSync(
    path.join(path.dirname(installed), "lib/messages/search-request.js"),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "81e59fe77490a458dc6006fcfabe1884292867f9d317a5544423dd7337d36f9c",
  );
  assert.equal(vendor(`${family}/package.json`).version, version);
});

test("real BER preserves distinct literal, backslash-hex, Unicode and ordinary equality identities", () => {
  const values = [
    "literal*)(uid=*)",
    String.raw`literal\2a\29\28uid=\2a\29`,
    "café",
    "ordinary",
  ];
  for (const value of values) {
    const actual = roundtrip(
      new filters.EqualityFilter({ attribute: "uid", value }),
    ).filter;
    assert.equal(actual.type, "EqualityFilter");
    assert.equal(actual.value, value);
    for (const target of values) {
      assert.equal(actual.matches({ uid: [target] }), value === target);
    }
  }
});

function checkOperator(filter, positive, negative, type, clauses) {
  const actual = roundtrip(filter).filter;
  assert.equal(actual.type, type);
  if (clauses !== undefined) assert.equal(actual.clauses.length, clauses);
  assert.equal(actual.matches(positive), true);
  assert.equal(actual.matches(negative), false);
}

test("the native filter AST retains boolean, substring and presence decisions", () => {
  const literal = () =>
    new filters.EqualityFilter({ attribute: "uid", value: "a*b" });
  checkOperator(
    literal(),
    { uid: ["a*b"] },
    { uid: ["axxb"] },
    "EqualityFilter",
  );
  checkOperator(
    new filters.AndFilter({
      filters: [
        literal(),
        new filters.EqualityFilter({ attribute: "cn", value: "allowed" }),
      ],
    }),
    { uid: ["a*b"], cn: ["allowed"] },
    { uid: ["a*b"], cn: ["denied"] },
    "AndFilter",
    2,
  );
  checkOperator(
    new filters.OrFilter({
      filters: [
        literal(),
        new filters.EqualityFilter({
          attribute: "uid",
          value: String.raw`a\2ab`,
        }),
      ],
    }),
    { uid: [String.raw`a\2ab`] },
    { uid: ["axxb"] },
    "OrFilter",
    2,
  );
  checkOperator(
    new filters.NotFilter({ filter: literal() }),
    { uid: ["axxb"] },
    { uid: ["a*b"] },
    "NotFilter",
    1,
  );
  checkOperator(
    new filters.SubstringFilter({
      attribute: "uid",
      initial: "literal",
      final: "tail",
    }),
    { uid: ["literal-middle-tail"] },
    { uid: ["unrelated"] },
    "SubstringFilter",
  );
  checkOperator(
    new filters.PresenceFilter({ attribute: "uid" }),
    { uid: ["ordinary"] },
    { cn: ["ordinary"] },
    "PresenceFilter",
  );
});

test("intermediate parsing retains the AST while public message JSON remains the existing string representation", () => {
  for (const value of ["a*b", String.raw`a\2ab`, "café", "ordinary"]) {
    const original = transmitted(
      new filters.EqualityFilter({ attribute: "uid", value }),
    );
    const reader = original.toBer();
    reader.readSequence();
    reader.readInt();
    const intermediate = messages.SearchRequest.parseToPojo(reader);
    assert.equal(intermediate.filter.type, "EqualityFilter");
    assert.equal(intermediate.filter.value, value);
    const actual = messages.LdapMessage.parse(original.toBer());
    assert.equal(typeof actual.pojo.filter, "string");
    assert.deepEqual(actual.pojo, original.pojo);
    assert.deepEqual(actual.json, actual.pojo);
    assert.deepEqual(JSON.parse(actual.toString()), actual.pojo);
    assert.deepEqual(
      new messages.SearchRequest(intermediate).toBer().buffer,
      original.toBer().buffer,
    );
  }
});

test("malformed BER remains refused after genuine parsing succeeds", () => {
  const packet = transmitted(
    new filters.EqualityFilter({ attribute: "uid", value: "ordinary" }),
  ).toBer().buffer;
  assert.equal(
    messages.LdapMessage.parse(new BerReader(packet)).filter.value,
    "ordinary",
  );
  assert.throws(() =>
    messages.LdapMessage.parse(new BerReader(packet.subarray(0, 4))),
  );
});
