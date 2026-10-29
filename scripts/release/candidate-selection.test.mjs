import assert from "node:assert/strict";
import test from "node:test";
import { POLICY } from "./lib/candidate-policy.mjs";
import { selectIntegration } from "./lib/candidate-selection.mjs";

const newest = "a".repeat(40);
const previous = "b".repeat(40);
const side = "c".repeat(40);
function fixture(passingSource = newest) {
  const queries = [];
  const visited = [];
  const ctx = {
    repository: POLICY.repository,
    now: Date.parse("2026-10-26T12:00:00Z"),
  };
  const successful = {
    id: 77,
    repository: { full_name: ctx.repository },
    head_repository: { full_name: ctx.repository },
    head_branch: "main",
    head_sha: passingSource,
    event: "push",
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    updated_at: "2026-10-26T01:00:00Z",
  };
  const api = {
    ctx,
    main: async () => newest,
    compatibleCi: async () => true,
    ancestor: async () => true,
    pages: async (path) => {
      queries.push(path);
      assert.match(path, /head_sha=[a-f0-9]{40}/);
      return path.endsWith(`head_sha=${passingSource}`) ? [successful] : [];
    },
    get: async (path) => {
      visited.push(path);
      return { parents: path.endsWith(newest) ? [{ sha: previous }] : [] };
    },
    attempt: async () => successful,
    jobs: async () =>
      ["TypeScript", "Bundle budgets", "Rust"].map((name, id) => ({
        name,
        id: id + 1,
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-26T00:00:00Z",
        completed_at: "2026-10-26T01:00:00Z",
      })),
  };
  return {
    service: { ctx, api, admission: async () => {} },
    queries,
    visited,
    successful,
  };
}

test("successful current main stops selection without enumerating an arbitrarily large CI history", async () => {
  const data = fixture();
  const selected = await selectIntegration(data.service, { reuse: false });
  assert.equal(selected.source_sha, newest);
  assert.equal(data.queries.length, 1);
  assert.equal(data.visited.length, 0);
  assert.equal(selected.reuse, "false");
});

test("pending current main selects the first proven ancestor and explicitly reports excluded work", async () => {
  const data = fixture(previous);
  const selected = await selectIntegration(data.service, { reuse: false });
  assert.equal(selected.source_sha, previous);
  assert.equal(selected.excluded_newer_main, "true");
  assert.equal(data.queries.length, 2);
  assert.equal(data.visited.length, 1);
});

test("a later completion cannot enter a selection whose cutoff is already fixed", async () => {
  const data = fixture();
  data.successful.updated_at = "2026-10-26T13:00:00Z";
  await assert.rejects(
    selectIntegration(data.service, { reuse: false }),
    /selection is incomplete/,
  );
});

test("a merge anchor selects the newest eligible first parent without visiting its green side branch", async () => {
  const data = fixture(previous);
  const pages = data.service.api.pages;
  data.service.api.pages = async (path) => {
    const runs = await pages(path);
    return path.endsWith(`head_sha=${side}`)
      ? [{ ...data.successful, head_sha: side }]
      : runs;
  };
  data.service.api.get = async (path) => {
    data.visited.push(path);
    return { parents: [{ sha: previous }, { sha: side }] };
  };
  const selected = await selectIntegration(data.service, { reuse: false });
  assert.equal(selected.source_sha, previous);
  assert.equal(selected.selected_main_sha, newest);
  assert.equal(selected.excluded_newer_main, "true");
  assert.equal(data.queries.length, 2);
  assert.ok(data.queries[0].endsWith(`head_sha=${newest}`));
  assert.ok(data.queries[1].endsWith(`head_sha=${previous}`));
  assert.deepEqual(data.visited, [`/git/commits/${newest}`]);
});

test("green CI only on a merge side parent cannot qualify a main candidate", async () => {
  const data = fixture(side);
  data.service.api.get = async (path) => {
    data.visited.push(path);
    return {
      parents: path.endsWith(newest) ? [{ sha: previous }, { sha: side }] : [],
    };
  };
  await assert.rejects(
    selectIntegration(data.service, { reuse: false }),
    /selection is incomplete/,
  );
  assert.equal(data.queries.length, 2);
  assert.ok(data.queries.every((path) => !path.endsWith(`head_sha=${side}`)));
});

test("malformed merge parent lists fail before following any parent", async () => {
  for (const parents of [
    undefined,
    null,
    {},
    [null],
    [{}],
    [{ sha: "not-a-commit" }],
    [{ sha: previous }, { sha: "invalid-side-parent" }],
  ]) {
    const data = fixture(previous);
    data.service.api.get = async () => ({ parents });
    await assert.rejects(
      selectIntegration(data.service, { reuse: false }),
      /Invalid main history parent/,
    );
    assert.equal(data.queries.length, 1);
  }
});

test("merge traversal keeps the bounded first-parent search even when side parents have green CI", async () => {
  const data = fixture(side);
  const chain = Array.from({ length: POLICY.source_walk_limit + 1 }, (_, i) =>
    (i + 1).toString(16).padStart(40, "0"),
  );
  data.service.api.main = async () => chain[0];
  data.service.api.get = async (path) => {
    data.visited.push(path);
    const index = chain.indexOf(path.split("/").at(-1));
    assert.notEqual(index, -1);
    return { parents: [{ sha: chain[index + 1] }, { sha: side }] };
  };
  await assert.rejects(
    selectIntegration(data.service, { reuse: false }),
    /selection is incomplete/,
  );
  assert.equal(data.queries.length, POLICY.source_walk_limit);
  assert.equal(data.visited.length, POLICY.source_walk_limit);
  assert.ok(data.queries.every((path) => !path.endsWith(`head_sha=${side}`)));
});
