#!/usr/bin/env node
/**
 * Generate the checked-in upstream SOPS fixtures (CONFORMANCE-02).
 *
 *   node apps/pages/scripts/sops-fixtures.mjs            # regenerate
 *   node apps/pages/scripts/sops-fixtures.mjs --check    # verify manifest
 *
 * Every encrypted fixture is produced by the pinned, checksum-verified
 * upstream binary, never by the browser engine; every expected plaintext is
 * upstream's own `--decrypt` output. Identities are synthetic, generated
 * here, and checked in beside the fixtures: they protect nothing.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as age from "age-encryption";
import {
  SOPS_SOURCE_COMMIT,
  SOPS_VERSION,
  provisionOracle,
  runSops,
} from "../../../packages/app-core/scripts/sops-oracle/oracle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "lib", "sops", "fixtures", "upstream");
const check = process.argv.includes("--check");

const oracle = provisionOracle({ allowDownload: !check });
if (oracle.error) {
  console.error(`incomplete: ${oracle.error}`);
  process.exit(2);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function identities(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const identity = await age.generateX25519Identity();
    list.push({ identity, recipient: await age.identityToRecipient(identity) });
  }
  return list;
}

/** Plain documents that cover the required profile (B02). */
const PLAIN = {
  "basic.yaml":
    'hello: world\ncount: 2\nratio: 1.5\nflag: true\nnothing: null\nempty: ""\nnote_unencrypted: visible\nlist:\n  - a\n  - 3\nnested:\n  k: v\n  deep:\n    - x: 1\n',
  "comments.yaml": readFileSync(
    join(here, "..", "src", "lib", "sops", "fixtures", "tree", "comments.yaml"),
    "utf8",
  ),
  "scalars.yaml":
    'when: 2001-12-14T21:59:43.10-05:00\nday: 2002-12-14\nspace: 2001-12-14 21:59:43.10\nhex: 0x1F\noctal: 017\nbin: 0b101\nunder: 1_000\nbig: 9223372036854775807\nsmall: -9223372036854775808\nnegzero: -0.0\ninf: .inf\nexp: 1e21\ntiny: 1e-7\nfloatint: 1.0\nyes_str: yes\nquoted_num: "42"\nquoted_date: "2002-12-14"\nmulti: |\n  first\n  second\nfolded: >-\n  one\n  two\nunicode: "h\u00e9llo \ud83c\udf0d \u00e9\u0301"\nkey with colon: v\n"a:b": colon-key\n',
  "numeric-keys.yaml":
    '"10": a\n"2": b\n"01": c\n__proto__: d\nconstructor: e\n',
  "multi.yaml": "a: 1\n---\n# doc two\nb: 2\n---\nc:\n  - 3\n",
  "empty-containers.yaml":
    'm: {}\ns: []\nn: null\ne: ""\nnested:\n  m: {}\n  s: []\n',
  "basic.json":
    '{\n  "10": "a",\n  "2": "b",\n  "name": "ada",\n  "big": 9223372036854775807,\n  "f": 1.5,\n  "e": 1e2,\n  "t": true,\n  "n": null,\n  "arr": [1, "x", {"k": null}, []],\n  "obj": {},\n  "unicode": "h\u00e9llo \ud83c\udf0d",\n  "note_unencrypted": "clear"\n}\n',
  "unencrypted-suffix.yaml":
    "secret: s\npublic_unencrypted: p\nnested:\n  inner_unencrypted:\n    deep: still-clear\n  other: hidden\n",
  "selectors.yaml":
    "# sops:enc\nsecret_a: one\n# plain\npublic_b: two\nnested:\n  # sops:enc\n  inner: three\n  other: four\nlist:\n  # sops:enc\n  - five\n  - six\npw: p\ntoken: t\n",
};

/** Cases: how upstream encrypts each plain document. */
/** One recipient, no selectors: the plain shape of each supported format. */
function simpleCases(r) {
  const one = (name, plain, format) => ({
    name,
    plain,
    format,
    args: ["--age", r(0)],
    identities: [0],
  });
  return [
    one("basic-yaml", "basic.yaml", "yaml"),
    one("basic-json", "basic.json", "json"),
    one("comments", "comments.yaml", "yaml"),
    one("scalars", "scalars.yaml", "yaml"),
    one("numeric-keys", "numeric-keys.yaml", "yaml"),
    one("multi", "multi.yaml", "yaml"),
    one("empty-containers", "empty-containers.yaml", "yaml"),
    one("unencrypted-suffix", "unencrypted-suffix.yaml", "yaml"),
    {
      name: "two-recipients",
      plain: "basic.yaml",
      format: "yaml",
      args: ["--age", `${r(0)},${r(1)}`],
      identities: [0, 1],
    },
  ];
}

/** Each of the five selectors upstream accepts, plus `--mac-only-encrypted`. */
function selectorCases(r) {
  const selected = (name, plain, flags) => ({
    name,
    plain,
    format: "yaml",
    args: ["--age", r(0), ...flags],
    identities: [0],
  });
  return [
    selected("encrypted-suffix", "unencrypted-suffix.yaml", [
      "--encrypted-suffix",
      "_unencrypted",
    ]),
    selected("encrypted-regex", "selectors.yaml", [
      "--encrypted-regex",
      "^(pw|token|inner)$",
    ]),
    selected("unencrypted-regex", "selectors.yaml", [
      "--unencrypted-regex",
      "^public",
    ]),
    selected("encrypted-comment-regex", "selectors.yaml", [
      "--encrypted-comment-regex",
      "sops:enc",
    ]),
    selected("unencrypted-comment-regex", "selectors.yaml", [
      "--unencrypted-comment-regex",
      "plain",
    ]),
    selected("mac-only-encrypted", "selectors.yaml", [
      "--mac-only-encrypted",
      "--encrypted-regex",
      "^(pw|token)$",
    ]),
  ];
}

/**
 * Key groups, which upstream reads from `.sops.yaml` rather than flags:
 * an explicit Shamir threshold below the group count, and the default
 * threshold (every group) for a JSON document.
 */
function groupCases(r) {
  return [
    {
      name: "groups-2of3",
      plain: "basic.yaml",
      format: "yaml",
      args: [],
      identities: [0, 2],
      config: `creation_rules:\n  - path_regex: \\.yaml$\n    shamir_threshold: 2\n    key_groups:\n      - age:\n          - ${r(0)}\n          - ${r(3)}\n      - age:\n          - ${r(1)}\n      - age:\n          - ${r(2)}\n`,
    },
    {
      name: "groups-json-all",
      plain: "basic.json",
      format: "json",
      args: [],
      identities: [0, 1],
      config: `creation_rules:\n  - path_regex: \\.json$\n    key_groups:\n      - age:\n          - ${r(0)}\n      - age:\n          - ${r(1)}\n`,
    },
  ];
}

function cases(ids) {
  const r = (i) => ids[i].recipient;
  return [...simpleCases(r), ...selectorCases(r), ...groupCases(r)];
}

async function generate() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ids = await identities(4);
  writeFileSync(
    join(out, "identities.json"),
    `${JSON.stringify(
      {
        $comment:
          "SYNTHETIC TEST IDENTITIES. Generated by scripts/sops-fixtures.mjs for fixtures only; they protect nothing and must never be used for real data.",
        identities: ids,
      },
      null,
      2,
    )}\n`,
  );
  for (const [name, text] of Object.entries(PLAIN))
    writeFileSync(join(out, `plain.${name}`), text);
  const manifest = {
    sopsVersion: SOPS_VERSION,
    sourceCommit: SOPS_SOURCE_COMMIT,
    oracle: { name: oracle.name, sha256: oracle.sha256 },
    generatedAt: new Date().toISOString(),
    cases: [],
  };
  for (const item of cases(ids)) {
    const plain = PLAIN[item.plain];
    const ext = item.format;
    const inputName = `doc.${ext}`;
    const encrypt = runSops(oracle.bin, {
      args: [
        "--encrypt",
        "--input-type",
        item.format,
        "--output-type",
        item.format,
        ...item.args,
      ],
      input: plain,
      inputName,
      identities: item.identities.map((i) => ids[i].identity),
      config: item.config ?? null,
    });
    if (encrypt.status !== 0) {
      console.error(`encrypt failed for ${item.name}: ${encrypt.stderr}`);
      process.exit(1);
    }
    const decrypt = runSops(oracle.bin, {
      args: [
        "--decrypt",
        "--input-type",
        item.format,
        "--output-type",
        item.format,
      ],
      input: encrypt.stdout,
      inputName,
      identities: item.identities.map((i) => ids[i].identity),
    });
    if (decrypt.status !== 0) {
      console.error(`decrypt failed for ${item.name}: ${decrypt.stderr}`);
      process.exit(1);
    }
    let decryptJson = null;
    if (item.format === "yaml") {
      const asJson = runSops(oracle.bin, {
        args: ["--decrypt", "--input-type", "yaml", "--output-type", "json"],
        input: encrypt.stdout,
        inputName,
        identities: item.identities.map((i) => ids[i].identity),
      });
      decryptJson = asJson.status === 0 ? asJson.stdout : null;
    }
    writeFileSync(join(out, `${item.name}.enc.${ext}`), encrypt.stdout);
    writeFileSync(join(out, `${item.name}.dec.${ext}`), decrypt.stdout);
    if (decryptJson !== null)
      writeFileSync(join(out, `${item.name}.dec.json`), decryptJson);
    if (item.config)
      writeFileSync(join(out, `${item.name}.sops.yaml`), item.config);
    manifest.cases.push({
      name: item.name,
      format: item.format,
      plain: `plain.${item.plain}`,
      args: item.args,
      config: item.config ? `${item.name}.sops.yaml` : null,
      identities: item.identities,
      encryptedSha256: sha256(encrypt.stdout),
      decryptedSha256: sha256(decrypt.stdout),
      decryptedJsonAvailable: decryptJson !== null,
    });
  }
  writeFileSync(
    join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`wrote ${manifest.cases.length} upstream fixtures to ${out}`);
}

function verify() {
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  let ok =
    manifest.sopsVersion === SOPS_VERSION &&
    manifest.sourceCommit === SOPS_SOURCE_COMMIT;
  for (const item of manifest.cases) {
    const enc = readFileSync(
      join(out, `${item.name}.enc.${item.format}`),
      "utf8",
    );
    const dec = readFileSync(
      join(out, `${item.name}.dec.${item.format}`),
      "utf8",
    );
    if (
      sha256(enc) !== item.encryptedSha256 ||
      sha256(dec) !== item.decryptedSha256
    ) {
      console.error(`fixture digest mismatch: ${item.name}`);
      ok = false;
    }
  }
  if (!existsSync(join(out, "identities.json"))) ok = false;
  console.log(
    ok
      ? `verified ${manifest.cases.length} fixtures (${readdirSync(out).length} files)`
      : "fixture verification failed",
  );
  process.exit(ok ? 0 : 1);
}

if (check) verify();
else await generate();
