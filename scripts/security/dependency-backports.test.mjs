import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
);
import {
  assertDependencyAbsent,
  dependencyPresent,
} from "./dependency-presence.mjs";

if (dependencyPresent("braces")) {
  const braces = require("braces");
  test("deep brace patterns and caller-provided ASTs fail before stack exhaustion", () => {
    const pattern = `${"{".repeat(4000)}a,b${"}".repeat(4000)}`;
    for (const operation of ["parse", "compile", "expand", "stringify"]) {
      assert.throws(() => braces[operation](pattern), /safe depth limit/);
    }
    let ast = { type: "text", value: "leaf" };
    for (let n = 0; n < 5000; n++) ast = { type: "root", nodes: [ast] };
    for (const operation of ["compile", "expand", "stringify"]) {
      assert.throws(() => braces[operation](ast), /safe depth limit/);
    }
    assert.deepEqual(braces.expand("file-{a,b}-{1..2}"), [
      "file-a-1",
      "file-a-2",
      "file-b-1",
      "file-b-2",
    ]);
  });
} else {
  test("braces is absent from all actual lock package, snapshot and consumer edges", () =>
    assertDependencyAbsent("braces"));
}
if (dependencyPresent("node-forge")) {
  const forge = require("node-forge");
  test("RSA rejects nested DigestAlgorithm garbage while accepting valid signatures", () => {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
    const md = forge.md.sha256.create().update("backport regression");
    const digest = md.digest().getBytes();
    assert.equal(keys.publicKey.verify(digest, keys.privateKey.sign(md)), true);
    const asn1 = forge.asn1;
    const obj = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(
          asn1.Class.UNIVERSAL,
          asn1.Type.OID,
          false,
          asn1.oidToDer(forge.oids.sha256).getBytes(),
        ),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
        asn1.create(
          asn1.Class.UNIVERSAL,
          asn1.Type.OCTETSTRING,
          false,
          "unvalidated garbage",
        ),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
    ]);
    const signature = keys.privateKey.sign(asn1.toDer(obj).getBytes(), "NONE");
    assert.throws(
      () => keys.publicKey.verify(digest, signature),
      /valid RSASSA-PKCS1/,
    );
  });
} else {
  test("node-forge is absent from all actual lock package, snapshot and consumer edges", () =>
    assertDependencyAbsent("node-forge"));
}
