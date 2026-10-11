import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { driverReach, gatesForPaths } from "./ci-gates.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const job = ci.split("  live-join-e2e:")[1]?.split("\n  rust:")[0] ?? "";
const reach = driverReach(root);
const gatesOf = (...paths) => [...gatesForPaths(paths, reach)];

describe("the live join walk's CI job (ADR 0150)", () => {
  it("is one shard per owner browser, each walking every joiner browser", () => {
    expect(job).toContain("owner: [chromium, firefox, webkit]");
    expect(job).toContain("LIVE_OWNER: ${{ matrix.owner }}");
    expect(job).toContain("LIVE_JOINERS: chromium,firefox,webkit");
    expect(job).toContain("fail-fast: false");
    expect(job).toContain("pnpm --filter @opensesame/pages verify:live-join");
  });

  it("runs the browsers the pinned Playwright installs, not the runner's own", () => {
    expect(job).toContain(
      "pnpm exec playwright install --with-deps chromium firefox webkit",
    );
    expect(job).not.toContain("PLAYWRIGHT_CHROMIUM");
    expect(job).toContain(
      "key: playwright-chromium-firefox-webkit-${{ runner.os }}-${{ steps.playwright.outputs.version }}",
    );
  });

  it("builds every server and both Pages builds the walks need, and fails rather than skip", () => {
    expect(job).toContain("go-version-file: scripts/test/live-turn/go.mod");
    expect(job).toContain("pnpm test:live-fixtures");
    expect(job).toContain("node scripts/lib/ci-pages-build.mjs");
    expect(job).toContain(
      "pnpm --filter @opensesame/pages build:live-dedicated",
    );
    expect(job).not.toContain("LIVE_SCENARIOS");
    expect(job).not.toContain("LIVE_CARRIERS");
    expect(job).not.toContain("continue-on-error");
  });

  it("pins every action it uses to a commit", () => {
    for (const [, ref] of job.matchAll(/uses: [^@\s]+@(\S+)/g))
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps the walk's artifacts on a failure", () => {
    expect(job).toContain("if: failure()");
    expect(job).toContain("path: artifacts/live-join/");
  });

  it("runs only when the diff reaches it, and Bundle budgets reports it", () => {
    expect(job).toContain("needs: changes");
    expect(job).toContain("if: needs.changes.outputs.live_join == 'true'");
    const check =
      ci.split("  bundle-check:")[1]?.split("  rust-check:")[0] ?? "";
    expect(check).toMatch(/needs: \[[^\]]*\blive-join-e2e\b[^\]]*\]/);
    expect(check).toContain('live="${{ needs.live-join-e2e.result }}"');
    expect(check).toMatch(
      /case "\$live" in\n\s+success\|skipped\) ;;\n\s+\*\) echo[^\n]*; exit 1 ;;/,
    );
  });
});

describe("what starts the live join walk", () => {
  it("its driver, the walks it imports and the servers it runs", () => {
    expect(gatesOf("apps/pages/scripts/verify-live-join.mjs")).toEqual([
      "live-join",
    ]);
    expect(gatesOf("apps/pages/scripts/lib/live-engines.mjs")).toContain(
      "live-join",
    );
    expect(gatesOf("apps/pages/scripts/lib/live-join-relayed.mjs")).toContain(
      "live-join",
    );
    for (const fixture of [
      "scripts/test/live-turn/main.go",
      "scripts/test/live-turn/go.sum",
      "scripts/test/live-fixtures.sh",
      "scripts/mtls/mtls-fixtures.sh",
    ])
      expect(gatesOf(fixture), fixture).toEqual(["live-join"]);
  });

  it("the live session code, the screens a joiner meets and the shared controls", () => {
    for (const path of [
      "packages/app-core/src/lib/live/guest.ts",
      "apps/pages/src/modules/sharing.live/LiveRoutesPanel.tsx",
      "apps/pages/src/components/CipherWordmark/use-cipher-lifecycle.ts",
      "apps/pages/src/sections/settings/files/VirtualFileEditor.tsx",
      "packages/app-core/src/sections/settings/live-transport-files.ts",
    ])
      expect(gatesOf(path), path).toContain("live-join");
  });

  it("not prose, tests, or a settings panel the walk never opens", () => {
    expect(gatesOf("docs/operators/live-sessions.md")).toEqual([]);
    expect(gatesOf("packages/app-core/src/lib/live/guest.test.ts")).toEqual([]);
    expect(
      gatesOf("apps/pages/src/sections/settings/security/Row.tsx"),
    ).not.toContain("live-join");
  });

  it("counts a server's source although it is outside the Pages build", async () => {
    const { bundlePackageDirs, pushPackageDirs, selectGates } = await import(
      "./ci-changed-areas.mjs"
    );
    expect([
      ...selectGates(
        root,
        ["scripts/test/live-turn/main.go"],
        bundlePackageDirs(root),
        pushPackageDirs(root),
      ),
    ]).toEqual(["live-join"]);
  });
});
