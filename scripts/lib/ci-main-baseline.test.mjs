import { describe, expect, it } from "vitest";
import {
  chooseSuccessfulMainBaseline,
  resolveChangeScope,
} from "./ci-main-baseline.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
const repo = "owner/repo";
const run = (n, extra = {}) => ({
  id: n,
  event: "push",
  head_branch: "main",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  head_repository: { full_name: repo },
  head_sha: sha(n),
  created_at: "2026-10-20T00:00:00Z",
  ...extra,
});
const options = {
  headSha: sha(5),
  currentRunId: 5,
  repository: repo,
  cutoff: "2026-10-21T00:00:00Z",
  isAncestor: (base, head) =>
    Number.parseInt(base, 16) < Number.parseInt(head, 16),
  distance: (base, head) =>
    Number.parseInt(head, 16) - Number.parseInt(base, 16),
};

describe("main uses a successful checked ancestor", () => {
  it("includes pushes whose runs were cancelled, failed or coalesced", () => {
    const runs = [
      run(4, { conclusion: "cancelled" }),
      run(3, { conclusion: "failure" }),
      run(1),
    ];
    // Push 5's event.before would be 4 and omit the unverified changes at 2–4.
    expect(chooseSuccessfulMainBaseline(runs, options)).toBe(sha(1));
  });
  it("orders by source ancestry rather than completion order", () => {
    expect(
      chooseSuccessfulMainBaseline([run(1), run(4), run(2)], options),
    ).toBe(sha(4));
  });
  it.each([
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "topic" },
    { path: ".github/workflows/unrelated.yml" },
    { status: "in_progress" },
    { head_repository: { full_name: "fork/repo" } },
    { head_sha: "not-a-sha" },
    { created_at: "2026-10-22T00:00:00Z" },
    { created_at: "invalid" },
  ])("rejects unrelated or unfinished evidence %j", (extra) => {
    expect(chooseSuccessfulMainBaseline([run(4, extra), run(1)], options)).toBe(
      sha(1),
    );
  });
  it("cannot use the current run, the same source or a descendant as its baseline", () => {
    expect(
      chooseSuccessfulMainBaseline(
        [run(5), run(6), run(4, { id: 5 })],
        options,
      ),
    ).toBe("");
  });
  it("falls back to all fast checks when there is no verified ancestor", async () => {
    const scope = await resolveChangeScope(
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: sha(5),
      },
      async () => "",
    );
    expect(scope).toEqual({ base_sha: "", head_sha: sha(5), scope: "all" });
  });
  it("keeps PR and merge-group base/head without querying main run history", async () => {
    for (const event of ["pull_request", "merge_group"]) {
      const scope = await resolveChangeScope(
        { GITHUB_EVENT_NAME: event, BASE_SHA: sha(1), HEAD_SHA: sha(4) },
        () => {
          throw new Error("unexpected query");
        },
      );
      expect(scope).toEqual({
        base_sha: sha(1),
        head_sha: sha(4),
        scope: "diff",
      });
    }
  });
});
