import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stampRelease, verifyRelease } from "./pages-release.mjs";
import {
  assertMergeGroupSignature,
  assertPrSignatures,
} from "./pr-signatures.mjs";

const revision = "a".repeat(40);
const earlier = "b".repeat(40);
const temporary = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("PR merge eligibility", () => {
  const verified = (sha) => ({
    sha,
    commit: { verification: { verified: true } },
  });
  const pr = { head: { sha: revision }, commits: 2 };
  it("accepts a complete, verified inventory at the exact head", () => {
    expect(() =>
      assertPrSignatures(pr, [verified(earlier), verified(revision)], revision),
    ).not.toThrow();
  });
  it("refuses unsigned or missing evidence even when builds passed", () => {
    for (const verification of [{ verified: false }, {}, undefined]) {
      expect(() =>
        assertPrSignatures(
          pr,
          [{ sha: earlier, commit: { verification } }, verified(revision)],
          revision,
        ),
      ).toThrow("Verified signatures required");
    }
  });
  it("refuses missing pages, empty inventories and changed PR heads", () => {
    for (const commits of [
      [],
      [verified(revision)],
      [verified(earlier), verified(earlier)],
    ])
      expect(() => assertPrSignatures(pr, commits, revision)).toThrow(
        "inventory",
      );
    expect(() =>
      assertPrSignatures(pr, [verified(earlier), verified(revision)], earlier),
    ).toThrow("head changed");
  });
});

describe("merge_group signature eligibility", () => {
  it("accepts a verified GitHub-created merge_group head", () => {
    expect(() =>
      assertMergeGroupSignature(
        { sha: revision, commit: { verification: { verified: true } } },
        revision,
      ),
    ).not.toThrow();
  });
  it("refuses an unverified or mismatched merge_group head", () => {
    expect(() =>
      assertMergeGroupSignature(
        { sha: revision, commit: { verification: { verified: false } } },
        revision,
      ),
    ).toThrow("Verified signatures required");
    expect(() =>
      assertMergeGroupSignature(
        { sha: earlier, commit: { verification: { verified: true } } },
        revision,
      ),
    ).toThrow("head changed");
  });
});

function releaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pages-release-test-"));
  temporary.push(directory);
  writeFileSync(
    join(directory, "index.html"),
    "<!doctype html><title>Pages</title>",
  );
  writeFileSync(join(directory, "os-runtime-config.json"), "{}\n");
  stampRelease(directory, revision);
  return directory;
}
function serve(directory) {
  const mock = vi.fn(async (address) => {
    const url = new URL(address);
    expect(url.origin).toBe("https://pages.example");
    expect(url.pathname).toMatch(/^\/OpenSesame\//);
    expect(url.searchParams.get("release")).toBe(revision);
    return new Response(
      readFileSync(join(directory, url.pathname.split("/").at(-1))),
    );
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Pages publication proof", () => {
  it("deterministically stamps and verifies exact served bytes", async () => {
    const directory = releaseFixture();
    const before = readFileSync(join(directory, "release.json"), "utf8");
    stampRelease(directory, revision);
    expect(readFileSync(join(directory, "release.json"), "utf8")).toBe(before);
    const mock = serve(directory);
    await verifyRelease("https://pages.example/OpenSesame", revision);
    expect(mock).toHaveBeenCalledTimes(3);
    for (const [, options] of mock.mock.calls) {
      expect(options.redirect).toBe("error");
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it("refuses stale release markers and missing digests", async () => {
    const directory = releaseFixture();
    serve(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "release.json")));
    for (const broken of [
      { ...manifest, revision: earlier },
      { ...manifest, sha256: {} },
    ]) {
      writeFileSync(join(directory, "release.json"), JSON.stringify(broken));
      await expect(
        verifyRelease("https://pages.example/OpenSesame/", revision),
      ).rejects.toThrow();
    }
  });
  it.each(["index.html", "os-runtime-config.json"])(
    "refuses stale %s even with a current marker",
    async (file) => {
      const directory = releaseFixture();
      serve(directory);
      writeFileSync(join(directory, file), "stale bytes");
      await expect(
        verifyRelease("https://pages.example/OpenSesame/", revision),
      ).rejects.toThrow("release digest");
    },
  );
  it("refuses non-HTTPS URLs, HTTP errors and oversized marker bodies", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(
      verifyRelease("http://pages.example/", revision),
    ).rejects.toThrow("HTTPS");
    expect(mock).not.toHaveBeenCalled();
    mock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(
      verifyRelease("https://pages.example/", revision),
    ).rejects.toThrow("HTTP 404");
    mock.mockResolvedValueOnce(new Response("x".repeat(4097)));
    await expect(
      verifyRelease("https://pages.example/", revision),
    ).rejects.toThrow("too large");
  });
  it("rejects malformed commit identifiers before writing a release", () => {
    expect(() => stampRelease("/unused", "main")).toThrow(
      "Invalid release SHA",
    );
  });
});

describe("release workflow wiring", () => {
  it("keeps signature enforcement in the ruleset and build admission in CI", () => {
    const ci = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const ruleset = JSON.parse(
      readFileSync(
        new URL("../../ops/github/default-branch.json", import.meta.url),
        "utf8",
      ),
    );
    expect(ruleset.rules).toContainEqual({ type: "required_signatures" });
    expect(ci).not.toContain("check-pr-signatures.mjs");
    expect(ci).not.toContain("check-merge-group-signature.mjs");
    expect(ci).not.toContain("pull-requests: read");
    expect(ci).toContain("node scripts/lib/ci-affected-builds.mjs run-ts");
    expect(ci).toContain("node scripts/lib/ci-affected-builds.mjs run-cargo");
    expect(ci).not.toContain("ci-affected-tests.mjs");
    for (const name of ["TypeScript", "Bundle budgets", "Rust"])
      expect(ci).toContain(`name: ${name}\n`);
  });
  it("stamps once during candidate construction and promotes that archive after qualification", () => {
    const producer = readFileSync(
      new URL("../../.github/workflows/candidate-build.yml", import.meta.url),
      "utf8",
    );
    const publisher = readFileSync(
      new URL("../../.github/workflows/release-publish.yml", import.meta.url),
      "utf8",
    );
    expect(producer.indexOf("pages-release.mjs stamp")).toBeLessThan(
      producer.indexOf("path: src/packed/*.tar.gz"),
    );
    expect(publisher).not.toContain("pages-release.mjs stamp");
    expect(publisher).toContain("verify-promotion");
    expect(publisher.indexOf("verify-site.mjs")).toBeGreaterThan(
      publisher.indexOf("uses: actions/deploy-pages@"),
    );
    const legacy = readFileSync(
      new URL("../../.github/workflows/deploy-pages.yml", import.meta.url),
      "utf8",
    );
    expect(legacy).not.toContain("uses: actions/deploy-pages@");
    expect(legacy).not.toContain("branches: [main]");
    expect(legacy).toContain("exit 1");
  });
});
