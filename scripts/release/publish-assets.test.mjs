import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSource,
  ownerMarker,
  prepareDraft,
  publishDraft,
  reconcileAssets,
  tagCommit,
} from "./publish-assets.mjs";
import {
  EVIDENCE_ASSETS,
  hash,
  productAssets,
  releaseInventory,
} from "./stage-release.mjs";

const source = "a".repeat(40);
const manifest = {
  source_sha: source,
  version: "0.2.0",
  candidate_id: `${source}-100-1`,
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "release-publish-test-"));
  for (const name of [
    ...productAssets(manifest.version),
    ...EVIDENCE_ASSETS.filter((name) => name !== "SHA256SUMS"),
  ]) {
    writeFileSync(
      join(directory, name),
      name === "candidate.json" ? JSON.stringify(manifest) : `fixture:${name}`,
    );
  }
  checksums(directory);
  return {
    directory,
    digest: hash(readFileSync(join(directory, "candidate.json"))),
  };
}
function checksums(directory) {
  const names = [
    ...productAssets(manifest.version),
    ...EVIDENCE_ASSETS.filter((name) => name !== "SHA256SUMS"),
  ].sort();
  writeFileSync(
    join(directory, "SHA256SUMS"),
    names
      .map((name) => `${hash(readFileSync(join(directory, name)))}  ${name}\n`)
      .join(""),
  );
}

function fakeWriteRequest(state, path, options) {
  if (path === "git/refs") {
    state.tag = options.body.sha;
    return {};
  }
  if (path === "releases") {
    state.release = { id: 1, ...options.body };
    return state.release;
  }
  if (path.startsWith("releases/assets/") && options.method === "DELETE") {
    state.assets = state.assets.filter(
      (item) => String(item.id) !== path.split("/").at(-1),
    );
    return null;
  }
  if (path === "releases/1" && options.method === "PATCH") {
    Object.assign(state.release, options.body);
    return state.release;
  }
  throw new Error(`Unhandled fake API request ${path}`);
}

function fakeApi() {
  const state = {
    tag: null,
    release: null,
    assets: [],
    writes: [],
    failAfter: 2,
    latest: null,
    main: source,
  };
  const api = {
    async request(path, options = {}) {
      if (options.method) state.writes.push({ path, ...options });
      if (path === "git/ref/heads/main")
        return { object: { type: "commit", sha: state.main } };
      if (path.startsWith("compare/"))
        return { merge_base_commit: { sha: source } };
      if (path.startsWith("contents/"))
        return {
          content: Buffer.from(
            '[workspace.package]\nversion = "0.2.0"\n',
          ).toString("base64"),
        };
      if (path.startsWith("git/ref/tags/"))
        return state.tag
          ? { object: { type: "commit", sha: state.tag } }
          : null;
      if (path === "releases/latest") return state.latest;
      if (path.startsWith("releases/tags/")) return state.release;
      return fakeWriteRequest(state, path, options);
    },
    async assets() {
      return state.assets;
    },
    async upload(_id, name, bytes) {
      if (state.assets.length === state.failAfter) {
        state.failAfter = -1;
        throw new Error("interrupted upload");
      }
      const asset = {
        id: state.writes.length + 100,
        name,
        size: bytes.length,
        digest: `sha256:${hash(bytes)}`,
        state: "uploaded",
      };
      state.writes.push({ upload: name });
      state.assets.push(asset);
      return asset;
    },
  };
  return { api, state };
}

test("partial draft resumes without replacing product bytes and publishes only complete inventory", async () => {
  const f = fixture();
  const { api, state } = fakeApi();
  try {
    await assert.rejects(
      prepareDraft(api, f.directory, manifest, f.digest),
      /interrupted/,
    );
    assert.equal(state.assets[0].name, "candidate.json");
    assert.equal(state.release.draft, true);
    assert.equal(state.release.generate_release_notes, true);
    assert.ok(state.release.body.startsWith(ownerMarker(manifest, f.digest)));
    const original = state.assets.map((asset) => asset.id);
    await prepareDraft(api, f.directory, manifest, f.digest);
    for (const id of original)
      assert.ok(state.assets.some((asset) => asset.id === id));
    assert.equal(
      state.assets.length,
      releaseInventory(f.directory, manifest).length,
    );
    await publishDraft(api, f.directory, manifest, f.digest);
    assert.equal(state.release.draft, false);
    const count = state.writes.length;
    await publishDraft(api, f.directory, manifest, f.digest);
    assert.equal(
      state.writes.length,
      count,
      "already published exact release is an idempotent no-op",
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("fresh evidence replaces only unpublished staging metadata, never product or published assets", async () => {
  const f = fixture();
  const { api, state } = fakeApi();
  state.failAfter = -1;
  try {
    await prepareDraft(api, f.directory, manifest, f.digest);
    const productIds = state.assets
      .filter((asset) => productAssets(manifest.version).includes(asset.name))
      .map((asset) => asset.id);
    writeFileSync(
      join(f.directory, "promotion.json"),
      "fresh verified receipt set",
    );
    checksums(f.directory);
    await prepareDraft(api, f.directory, manifest, f.digest);
    for (const id of productIds)
      assert.ok(state.assets.some((asset) => asset.id === id));
    assert.equal(
      state.writes.filter((write) => write.method === "DELETE").length,
      2,
    );
    await publishDraft(api, f.directory, manifest, f.digest);
    writeFileSync(join(f.directory, "promotion.json"), "later evidence");
    checksums(f.directory);
    await assert.rejects(
      prepareDraft(api, f.directory, manifest, f.digest),
      /Immutable/,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("wrong-candidate draft and moved tag fail before uploads", async () => {
  const f = fixture();
  const { api, state } = fakeApi();
  state.failAfter = -1;
  try {
    state.release = {
      id: 1,
      draft: true,
      body: "someone else's draft",
      target_commitish: source,
    };
    await assert.rejects(
      prepareDraft(api, f.directory, manifest, f.digest),
      /owned draft/,
    );
    assert.equal(state.writes.length, 0);
    state.release = null;
    state.tag = "b".repeat(40);
    await assert.rejects(
      prepareDraft(api, f.directory, manifest, f.digest),
      /tag moved/,
    );
    assert.equal(state.writes.length, 0);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("inventory rejects extras, duplicates, missing published files and immutable product collisions", () => {
  const expected = [
    { name: "candidate.json", size: 1, sha256: "a".repeat(64) },
  ];
  const good = {
    id: 1,
    name: "candidate.json",
    size: 1,
    digest: `sha256:${"a".repeat(64)}`,
    state: "uploaded",
  };
  for (const actual of [
    [{ ...good, name: "extra" }],
    [good, good],
    [{ ...good, digest: `sha256:${"b".repeat(64)}` }],
  ]) {
    assert.throws(() => reconcileAssets(actual, expected, true));
  }
  assert.throws(() => reconcileAssets([], expected, false), /incomplete/);
});

test("source check rejects a release version rollback and peels annotated tags", async () => {
  const { api, state } = fakeApi();
  state.latest = { tag_name: "v0.3.0" };
  await assert.rejects(assertSource(api, manifest), /advance/);
  const peeled = await tagCommit(
    {
      async request(path) {
        return path.startsWith("git/ref/")
          ? { object: { type: "tag", sha: "b".repeat(40) } }
          : { object: { type: "commit", sha: source } };
      },
    },
    "v0.2.0",
  );
  assert.equal(peeled, source);
  assert.match(ownerMarker(manifest, "c".repeat(64)), /opensesame-candidate:/);
});
