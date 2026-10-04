import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowsServiceWorkers,
  firstLoadCalls,
  isWalkScript,
  walksThatRaceTheFirstLoad,
  withoutComments,
} from "./sw-first-load-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const walk = (path) => ({ path: `apps/pages/scripts/${path}`, text: "" });

const racing = `
const context = await browser.newContext({ serviceWorkers: "allow" });
const page = await context.newPage();
await page.goto(scope);
await doorGuest(page).click();
`;
const guarded = `
import { trackControlledBirth, untilBornControlled } from "./lib/push-worker-harness.mjs";
const context = await browser.newContext({ serviceWorkers: "allow" });
await trackControlledBirth(context);
const page = await context.newPage();
await page.goto(scope);
await untilBornControlled(page);
`;

describe("which scripts are walks", () => {
  it("covers scripts under the Pages scripts directory, not their tests", () => {
    expect(isWalkScript("apps/pages/scripts/verify-push.mjs")).toBe(true);
    expect(isWalkScript("apps/pages/scripts/lib/capture-harness.mjs")).toBe(
      true,
    );
    expect(isWalkScript("apps/pages/scripts/lib/push-stack.test.mjs")).toBe(
      false,
    );
    expect(isWalkScript("apps/pages/src/lib/a.mjs")).toBe(false);
    expect(isWalkScript("scripts/lib/a.mjs")).toBe(false);
  });
});

describe("a context that lets service workers run", () => {
  it("is recognised by its option, in any quoting", () => {
    expect(allowsServiceWorkers('{ serviceWorkers: "allow" }')).toBe(true);
    expect(allowsServiceWorkers("{ serviceWorkers:'allow' }")).toBe(true);
    expect(allowsServiceWorkers('{ serviceWorkers: "block" }')).toBe(false);
    expect(allowsServiceWorkers("browser.newContext()")).toBe(false);
  });

  it("is not recognised in a comment", () => {
    expect(allowsServiceWorkers('// serviceWorkers: "allow"\nx()')).toBe(false);
    expect(allowsServiceWorkers('/* serviceWorkers: "allow" */')).toBe(false);
  });

  it("keeps a URL's slashes when comments are stripped", () => {
    const code = withoutComments('go("http://a.test/") // note\nnext();');
    expect(code).toContain("http://a.test/");
    expect(code).not.toContain("note");
  });
});

describe("the two halves of the cure", () => {
  it("are read as calls, not as an import or a word in a comment", () => {
    expect(firstLoadCalls(guarded)).toEqual({ tracks: true, waits: true });
    expect(firstLoadCalls(racing)).toEqual({ tracks: false, waits: false });
    expect(
      firstLoadCalls(
        "import { trackControlledBirth, untilBornControlled } from './h.mjs';",
      ),
    ).toEqual({ tracks: false, waits: false });
    expect(
      firstLoadCalls("// untilBornControlled(page)\ntrackControlledBirth(c)"),
    ).toEqual({ tracks: true, waits: false });
  });
});

describe("walksThatRaceTheFirstLoad", () => {
  it("flags a walk that allows workers and does neither", () => {
    expect(
      walksThatRaceTheFirstLoad([{ ...walk("verify-x.mjs"), text: racing }]),
    ).toEqual([
      {
        path: "apps/pages/scripts/verify-x.mjs",
        missing: ["trackControlledBirth(context)", "untilBornControlled(page)"],
      },
    ]);
  });

  it("names the half that is missing", () => {
    const text = guarded.replace("await untilBornControlled(page);", "");
    expect(
      walksThatRaceTheFirstLoad([{ ...walk("verify-x.mjs"), text }]).map(
        (f) => f.missing,
      ),
    ).toEqual([["untilBornControlled(page)"]]);
  });

  it("passes a guarded walk, a blocked one and a script outside the scope", () => {
    expect(
      walksThatRaceTheFirstLoad([
        { ...walk("verify-a.mjs"), text: guarded },
        {
          ...walk("verify-b.mjs"),
          text: racing.replace("allow", "block"),
        },
        { path: "scripts/lib/other.mjs", text: racing },
        { ...walk("lib/a.test.mjs"), text: racing },
      ]),
    ).toEqual([]);
  });
});

function scriptsUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return scriptsUnder(full);
    return entry.name.endsWith(".mjs") ? [full] : [];
  });
}

describe("the workspace", () => {
  it("has no browser walk that lets workers run without outwaiting the first load", () => {
    const files = scriptsUnder(join(root, "apps/pages/scripts")).map(
      (full) => ({
        path: relative(root, full).split("\\").join("/"),
        text: readFileSync(full, "utf8"),
      }),
    );
    const allowing = files.filter(
      (file) => isWalkScript(file.path) && allowsServiceWorkers(file.text),
    );
    // The sweep is only a guard while it can see the walks it guards.
    expect(allowing.length).toBeGreaterThanOrEqual(4);
    expect(walksThatRaceTheFirstLoad(files)).toEqual([]);
  });
});
