import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { turboCacheEnv } from "./ci-turbo-cache.mjs";

const token = "remote-cache-token";
const team = "opensesame";
const repository = "Tyler-R-Kendrick/OpenSesame";

function context(overrides = {}) {
  return {
    eventName: "push",
    repository,
    token,
    team,
    ...overrides,
  };
}

describe("turboCacheEnv", () => {
  it("writes the remote cache when a same-repository run has a token", () => {
    expect(
      turboCacheEnv(
        context({
          eventName: "pull_request",
          headRepository: repository,
        }),
      ),
    ).toEqual({
      TURBO_TOKEN: token,
      TURBO_REMOTE_CACHE_READ_ONLY: "false",
      TURBO_TEAM: team,
    });
    expect(turboCacheEnv(context({ eventName: "merge_group" }))).toMatchObject({
      TURBO_REMOTE_CACHE_READ_ONLY: "false",
    });
  });

  it("is read-only for a fork pull request even when a token is present", () => {
    expect(
      turboCacheEnv(
        context({
          eventName: "pull_request",
          headRepository: "other/OpenSesame",
        }),
      ),
    ).toEqual({
      TURBO_TOKEN: token,
      TURBO_REMOTE_CACHE_READ_ONLY: "true",
      TURBO_TEAM: team,
    });
  });

  it("is read-only when the token secret is missing", () => {
    for (const tokenValue of [undefined, "", "   "]) {
      expect(
        turboCacheEnv(context({ token: tokenValue }))
          .TURBO_REMOTE_CACHE_READ_ONLY,
      ).toBe("true");
    }
    expect(turboCacheEnv(context({ token: undefined })).TURBO_TOKEN).toBe("");
    expect(
      turboCacheEnv({
        event_name: "pull_request",
        repository,
        event: {
          pull_request: { head: { repo: { full_name: repository } } },
        },
        secrets: {},
        vars: { TURBO_TEAM: team },
      }),
    ).toMatchObject({
      TURBO_TOKEN: "",
      TURBO_REMOTE_CACHE_READ_ONLY: "true",
      TURBO_TEAM: team,
    });
  });

  it("treats a pull request with no head repository as read-only", () => {
    expect(
      turboCacheEnv(context({ eventName: "pull_request" }))
        .TURBO_REMOTE_CACHE_READ_ONLY,
    ).toBe("true");
  });

  it("does not print the token when invoked without GITHUB_ENV", () => {
    const env = { ...process.env, GITHUB_ENV: "" };
    env.TURBO_TOKEN = token;
    env.TURBO_TEAM = team;
    env.GITHUB_EVENT_NAME = "push";
    env.GITHUB_REPOSITORY = repository;
    const result = spawnSync(
      process.execPath,
      [join(repoRootFromHere(), "scripts/lib/ci-turbo-cache.mjs")],
      { env, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TURBO_TOKEN=set");
    expect(result.stdout).not.toContain(token);
    expect(result.stderr ?? "").not.toContain(token);
  });
});

describe("ci.yml remote cache wiring", () => {
  it("sets the three cache variables and keeps fork pulls read-only", () => {
    const ci = readFileSync(
      join(repoRootFromHere(), ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(ci).toContain("TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}");
    expect(ci).toContain("TURBO_TEAM: ${{ vars.TURBO_TEAM }}");
    expect(ci).toContain("TURBO_REMOTE_CACHE_READ_ONLY:");
    expect(ci).toContain(
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(ci).toContain("node scripts/lib/ci-turbo-cache.mjs");
  });
});

const scratch = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("appends the cache env file without echoing the token", () => {
  const directory = mkdtempSync(join(tmpdir(), "turbo-cache-env-"));
  scratch.push(directory);
  const file = join(directory, "github-env");
  const result = spawnSync(
    process.execPath,
    [join(repoRootFromHere(), "scripts/lib/ci-turbo-cache.mjs")],
    {
      env: {
        ...process.env,
        GITHUB_ENV: file,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: repository,
        HEAD_REPOSITORY: "other/OpenSesame",
        TURBO_TOKEN: token,
        TURBO_TEAM: team,
      },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr ?? "").not.toContain(token);
  expect(readFileSync(file, "utf8")).toBe(
    `TURBO_TOKEN=${token}\nTURBO_REMOTE_CACHE_READ_ONLY=true\nTURBO_TEAM=${team}\n`,
  );
});
