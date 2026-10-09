/**
 * Every egress purpose a capability names is one its catalog descriptor
 * declared, and is read from that declaration rather than retyped.
 *
 * `createEgressPort` classifies a request by matching its `purpose` against
 * the descriptor's `egress` entries by exact string. A module that spells the
 * purpose its own way is refused as `purpose-not-declared` on every request,
 * before any socket opens, and the person is told the service is unreachable
 * (`notifications.web-push` shipped like that: "push enrolment with the
 * configured Identity API" against a declared "the configured Identity API's
 * push enrolment"). This sweeps every production source file of every app and
 * package that deals in egress for the places a purpose is handed to the egress
 * port, so the whole class fails here instead of in a person's browser. What
 * counts as a place, and how a purpose is traced, is
 * `egress-purposes.test-support.ts`; the fixtures below prove each shape of
 * evasion it knows now fails.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINEAR_API_PURPOSE,
  NATIVE_PROVIDER_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { PLUGIN_DAEMON_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-optional-plugins.js";
import {
  TAILNET_DEVICES_PURPOSE,
  WEB_PUSH_ENROLMENT_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
import {
  LIVE_CARRIER_PURPOSE,
  PWNED_PURPOSE,
  TWO_FACTOR_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import type ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type ModuleLoader,
  type Site,
  analyze,
  catalogConstant,
  literalCapability,
  parse,
} from "./egress-purposes.test-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../../..");
const ROOTS = ["apps", "packages", "examples"].map((dir) => join(repo, dir));
const NOT_PRODUCTION =
  /(\.test\.|\.test-support\.|\.fixture\.|\.d\.ts$|\/__tests__\/|\/doubles\/|test-harness|test-context|runtime-test-kit)/;
const CATALOG_FILE = /\/capabilities\/catalog-[a-z-]+\.ts$/;
const CATALOG_DIR = join(repo, "packages/app-core/src/lib/capabilities");

/** Every purpose constant a catalog file exports, with its text. */
const catalogConstants: ReadonlyMap<string, string> = new Map(
  Object.entries({
    LINEAR_API_PURPOSE,
    NATIVE_PROVIDER_PURPOSE,
    LIVE_CARRIER_PURPOSE,
    PLUGIN_DAEMON_PURPOSE,
    PWNED_PURPOSE,
    TAILNET_DEVICES_PURPOSE,
    TWO_FACTOR_PURPOSE,
    WEB_PUSH_ENROLMENT_PURPOSE,
  }),
);

const declared = CAPABILITY_CATALOG.capabilities.flatMap((d) =>
  d.egress.map((e) => ({ capability: d.id, purpose: e.purpose })),
);

/** The `*_PURPOSE` names the catalog files export, read from their source. */
function exportedPurposeNames(): string[] {
  return readdirSync(CATALOG_DIR)
    .filter((name) => /^catalog-.*\.ts$/.test(name))
    .flatMap((name) =>
      [
        ...readFileSync(join(CATALOG_DIR, name), "utf8").matchAll(
          /^export const ([A-Z_]+_PURPOSE)\b/gm,
        ),
      ].map((match) => match[1] ?? ""),
    )
    .sort();
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (["node_modules", "dist", "target", "coverage", ".turbo"].includes(name))
      return [];
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !NOT_PRODUCTION.test(path) ? [path] : [];
  });
}

/** A module a source imports: relative, or this repository's app-core alias. */
const loadFromDisk: ModuleLoader = (from, specifier) => {
  const base = specifier.startsWith("@opensesame/app-core/")
    ? join(repo, "packages/app-core/src", specifier.slice(21))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
  ]) {
    if (existsSync(candidate))
      return parse(candidate, readFileSync(candidate, "utf8"));
  }
  return null;
};

type Located = Site & { file: string };

const files = ROOTS.filter(existsSync)
  .flatMap(walk)
  .filter((file) => !CATALOG_FILE.test(file))
  .filter((file) => /egress/i.test(readFileSync(file, "utf8")));
const analysed = files.map((file) => ({
  file: relative(repo, file),
  ...analyze(parse(file, readFileSync(file, "utf8")), loadFromDisk),
}));
const SITES: Located[] = analysed.flatMap((a) =>
  a.sites.map((site) => ({ ...site, file: a.file })),
);
const FINDINGS = analysed.flatMap((a) =>
  a.findings.map((finding) => ({ ...finding, file: a.file })),
);

function judge(site: Site, load: ModuleLoader): string {
  const found = catalogConstant(site, load);
  if ("problem" in found) return found.problem;
  const text = catalogConstants.get(found.name);
  if (text === undefined)
    return `${found.name} is not a listed catalog constant`;
  const owners = declared
    .filter((entry) => entry.purpose === text)
    .map((entry) => entry.capability);
  if (owners.length === 0) return `no descriptor declares ${found.name}`;
  const capability = literalCapability(site);
  if (capability !== null && !owners.includes(capability))
    return `${capability} does not declare ${found.name}`;
  return "";
}

describe("the sweep finds the places a purpose reaches the egress port", () => {
  it("covers every package that deals in egress, and the capabilities known to use one", () => {
    const seen = new Set(SITES.map((site) => site.file));
    for (const known of [
      "apps/pages/src/modules/connectors.external/linear-runtime.ts",
      "apps/pages/src/modules/connectors.external/native-runtime.ts",
      "apps/pages/src/modules/notifications.web-push/runtime.ts",
      "apps/pages/src/modules/sharing.live/carriers/allowed.ts",
      "packages/app-core/src/lib/tailnet-sync/plugin-daemon.ts",
    ])
      expect(seen, known).toContain(known);
    const read = new Set(
      analysed.map((a) => a.file.split("/").slice(0, 2).join("/")),
    );
    expect(read).toContain("apps/pages");
    expect(read).toContain("packages/app-core");
  });
});

describe("every purpose handed to egress is the catalog's own", () => {
  it.each(SITES.map((site) => [`${site.file}:${site.line}`, site] as const))(
    "%s",
    (_where, site) => {
      expect(judge(site, loadFromDisk)).toBe("");
    },
  );

  it("leaves no egress call whose meta the sweep cannot follow", () => {
    expect(FINDINGS.map((f) => `${f.file}:${f.line} ${f.problem}`)).toEqual([]);
  });
});

describe("the catalog's declarations can be matched", () => {
  it("never leaves a purpose empty or shared inside one capability", () => {
    for (const descriptor of CAPABILITY_CATALOG.capabilities) {
      const purposes = descriptor.egress.map((e) => e.purpose);
      for (const purpose of purposes)
        expect(purpose.trim(), descriptor.id).not.toBe("");
      expect(new Set(purposes).size, descriptor.id).toBe(purposes.length);
    }
  });

  it("lists every purpose constant the catalog files export, and declares each on some descriptor", () => {
    expect([...catalogConstants.keys()].sort()).toEqual(exportedPurposeNames());
    for (const [name, text] of catalogConstants)
      expect(
        declared.some((entry) => entry.purpose === text),
        name,
      ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The sweep is only worth what it catches: each shape below is a way a
 * purpose could reach egress unnoticed, and each must now fail.
 * ------------------------------------------------------------------ */

const CATALOG =
  "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
const nothing: ModuleLoader = () => null;

/** What the sweep says about a source: its findings and its sites' verdicts. */
function verdicts(text: string, load: ModuleLoader = nothing): string[] {
  const source: ts.SourceFile = parse("/fixture/module.ts", text);
  const { sites, findings } = analyze(source, load);
  return [
    ...findings.map((f) => f.problem),
    ...sites.map((site) => judge(site, load)).filter(Boolean),
  ];
}

describe("shapes that must fail", () => {
  const retyped = '"push enrolment with the configured Identity API"';
  const evasions: [string, string, RegExp][] = [
    [
      "an identifier key",
      `egress.fetch(u, i, { capability: "x", purpose: ${retyped} });`,
      /retypes the purpose/,
    ],
    [
      "a quoted key",
      `egress.fetch(u, i, { capability: "x", "purpose": ${retyped} });`,
      /retypes the purpose/,
    ],
    [
      "a computed key",
      `egress.fetch(u, i, { capability: "x", ["purpose"]: ${retyped} });`,
      /retypes the purpose/,
    ],
    [
      "an object built into a variable and passed on",
      `const meta = { capability: "x", purpose: ${retyped} };\negress.fetch(u, i, meta);`,
      /retypes the purpose/,
    ],
    [
      "an element-access call",
      `egress["fetch"](u, i, { purpose: ${retyped} });`,
      /retypes the purpose/,
    ],
    [
      "a destructured fetch",
      `const { fetch } = egress;\nfetch(u, i, { purpose: ${retyped} });`,
      /retypes the purpose/,
    ],
    [
      "a decide call",
      `egress.decide(u, { purpose: ${retyped} });`,
      /retypes the purpose/,
    ],
    [
      "a meta that is a parameter",
      "function go(egress, meta) { return egress.fetch(u, i, meta); }",
      /cannot trace the meta/,
    ],
    [
      "a computed purpose",
      "egress.fetch(u, i, { purpose: `a ${b}` });",
      /retypes|computes/,
    ],
    [
      "a purpose imported from somewhere that is not a catalog",
      `import { P } from "./local.js";\negress.fetch(u, i, { capability: "x", purpose: P });`,
      /not a catalog|imports P from/,
    ],
    [
      "a constant no descriptor declares",
      `import { NOT_DECLARED } from "${CATALOG}";\negress.fetch(u, i, { purpose: NOT_DECLARED });`,
      /not a listed catalog constant/,
    ],
    [
      "a declared constant under another capability's name",
      `import { WEB_PUSH_ENROLMENT_PURPOSE } from "${CATALOG}";\negress.fetch(u, i, { capability: "wallet.spending", purpose: WEB_PUSH_ENROLMENT_PURPOSE });`,
      /does not declare/,
    ],
  ];

  it.each(evasions)("%s", (_name, text, expected) => {
    const found = verdicts(text);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toMatch(expected);
  });

  it("follows an imported meta object into its module, and flags what is retyped there", () => {
    const elsewhere = parse(
      "/fixture/meta.ts",
      `export const META = { capability: "x", purpose: ${retyped} };`,
    );
    const load: ModuleLoader = () => elsewhere;
    // The importing file has nothing to say about a meta it merely passes on;
    // the module that declares it is a site of its own and fails there.
    expect(
      verdicts(
        'import { META } from "./meta.js";\negress.fetch(u, i, META);',
        load,
      ),
    ).toEqual([]);
    const { sites } = analyze(
      parse(
        "/fixture/meta.ts",
        `import { egress } from "e";\nexport const META = { capability: "x", purpose: ${retyped} };`,
      ),
      nothing,
    );
    expect(sites.map((s) => judge(s, nothing)).join()).toMatch(/retypes/);
  });

  it("follows a purpose through an imported meta's property", () => {
    const text = `import { META } from "./meta.js";\negress.fetch(u, i, { purpose: META.purpose });`;
    const elsewhere = parse(
      "/fixture/meta.ts",
      `import { WEB_PUSH_ENROLMENT_PURPOSE as P } from "${CATALOG}";\nexport const META = { capability: "notifications.web-push", purpose: P };`,
    );
    expect(verdicts(text, () => elsewhere)).toEqual([]);
  });
});

describe("shapes that must pass", () => {
  it("admits native provider operations only under their owning capability", () => {
    const source = `import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";`;
    expect(
      verdicts(
        `${source} egress.fetch(u, i, { capability: "connectors.external", purpose: NATIVE_PROVIDER_PURPOSE });`,
      ),
    ).toEqual([]);
    expect(
      verdicts(
        `${source} egress.fetch(u, i, { capability: "wallet.spending", purpose: NATIVE_PROVIDER_PURPOSE });`,
      ),
    ).toEqual(["wallet.spending does not declare NATIVE_PROVIDER_PURPOSE"]);
  });

  it("accepts a catalog constant, under an import alias, inline or through a const", () => {
    expect(
      verdicts(
        `import { WEB_PUSH_ENROLMENT_PURPOSE as ENROL } from "${CATALOG}";\negress.fetch(u, i, { capability: "notifications.web-push", purpose: ENROL });`,
      ),
    ).toEqual([]);
    expect(
      verdicts(
        `import { WEB_PUSH_ENROLMENT_PURPOSE } from "${CATALOG}";\nconst META = { capability: "notifications.web-push", purpose: WEB_PUSH_ENROLMENT_PURPOSE };\negress.fetch(u, i, META);`,
      ),
    ).toEqual([]);
  });

  it("ignores a purpose in a file that never deals in egress, and a platform fetch", () => {
    expect(verdicts('const k = { purpose: "workload-root" };')).toEqual([]);
    expect(verdicts("const egress = 1;\nfetch(url, init);")).toEqual([]);
  });
});
