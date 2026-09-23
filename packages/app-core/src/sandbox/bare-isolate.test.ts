/**
 * The bare-isolate proof (ADR 0133 §6). The portable entry and the runtime
 * contract are bundled and run inside `vm.createContext({})` — a V8 context
 * with the ECMAScript built-ins and nothing else: no `crypto`, no
 * `TextEncoder`, no `URL`, no timers, no `process`, no DOM. That is what
 * Android's JavaScriptSandbox gives the core. Loading the core there must
 * touch no platform global, and the golden vault vectors must open unchanged.
 */
import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const osDomain = join(here, "../../../os-domain/src");
const fixture = JSON.parse(
  readFileSync(join(here, "../lib/vault/fixtures/vault-vectors.json"), "utf8"),
);

async function bundle(entry: string, globalName: string): Promise<string> {
  const result = await build({
    entryPoints: [join(here, entry)],
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["browser", "import", "default"],
    alias: {
      "@opensesame/os-domain/authority-templates": join(
        osDomain,
        "authority-templates/index.ts",
      ),
      "@opensesame/os-domain/wallet": join(osDomain, "wallet/index.ts"),
      "@opensesame/os-domain": join(osDomain, "browser.ts"),
    },
    logLevel: "silent",
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`esbuild emitted nothing for ${entry}`);
  return output.text;
}

type Json = ReturnType<typeof JSON.parse>;
let runtime = "";
let core = "";

/** A fresh, empty context with the contract installed and the core loaded. */
function isolate(entropy = true): Context {
  const context = createContext({});
  runInContext(runtime, context);
  runInContext(
    "OpenSesameRuntime.installRuntimeContract(globalThis, globalThis.__options)",
    Object.assign(context, {
      __options: entropy
        ? {
            getRandomValues: (array: Uint8Array | null) =>
              array === null ? array : randomFillSync(array),
          }
        : {},
    }),
  );
  runInContext(core, context);
  return context;
}

/** Run `source` inside the isolate; results cross back as JSON only. */
async function inside(context: Context, source: string): Promise<Json> {
  const text = await runInContext(
    `(async () => JSON.stringify(await (async () => { ${source} })()))()`,
    context,
  );
  return text === undefined ? undefined : JSON.parse(text);
}

beforeAll(async () => {
  runtime = await bundle("runtime-contract.ts", "OpenSesameRuntime");
  core = await bundle("portable.ts", "OpenSesameCore");
}, 60_000);

describe("the portable core in a bare V8 context", () => {
  it("starts from a context with no platform globals", () => {
    const empty = createContext({});
    const missing = runInContext(
      `["crypto","TextEncoder","URL","setTimeout","process","window","localStorage","navigator","fetch"].filter((name) => typeof globalThis[name] !== "undefined")`,
      empty,
    );
    expect(JSON.parse(JSON.stringify(missing))).toEqual([]);
  });

  it("loads without a host and without touching a platform global", async () => {
    const context = isolate();
    expect(
      await inside(context, "return typeof OpenSesameCore.openVaultFile"),
    ).toBe("function");
    expect(
      await inside(
        context,
        "try { OpenSesameCore.createSandboxHost; return typeof globalThis.__opensesameAppCoreHost; } catch (e) { return String(e); }",
      ),
    ).toBe("undefined");
  });

  it("refuses a host without Unicode normalisation", async () => {
    const context = isolate();
    expect(
      await inside(context, "OpenSesameRuntime.assertHostIntl(); return 'ok'"),
    ).toBe("ok");
    expect(
      await inside(
        context,
        `const real = String.prototype.normalize;
         String.prototype.normalize = function () { return String(this); };
         try { OpenSesameRuntime.assertHostIntl(); return "accepted"; }
         catch (e) { return e.message; }
         finally { String.prototype.normalize = real; }`,
      ),
    ).toMatch(/cannot normalise Unicode/);
  });

  it.each(Object.entries(fixture.vectors))(
    "opens the %s vector unchanged",
    async (_name, vector: Json) => {
      const context = isolate();
      Object.assign(context, {
        __file: vector.file,
        __password: fixture.password,
      });
      const opened = await inside(
        context,
        `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
         return OpenSesameCore.openVaultFile(__file, __password);`,
      );
      expect({
        tomb: opened.tomb,
        bound: opened.bound,
        rev: opened.rev,
        items: opened.items.map(({ id, name, kind }: Json) => ({
          id,
          name,
          kind,
        })),
      }).toEqual(vector.expect);
    },
    120_000,
  );

  it("normalises the password with NFKC and refuses a wrong one", async () => {
    const context = isolate();
    Object.assign(context, {
      __file: fixture.vectors["export-personal"].file,
      __nfkc: fixture.passwordNfkc,
    });
    const result = await inside(
      context,
      `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
       const ok = await OpenSesameCore.openVaultFile(__file, __nfkc);
       let wrong = "opened";
       try { await OpenSesameCore.openVaultFile(__file, "not the password"); }
       catch (e) { wrong = e instanceof OpenSesameCore.WrongPasswordError ? "WrongPasswordError" : String(e); }
       return { items: ok.items.length, wrong };`,
    );
    expect(result).toEqual({
      items: fixture.vectors["export-personal"].expect.items.length,
      wrong: "WrongPasswordError",
    });
  }, 120_000);

  it("never runs an untrusted pattern on the isolate's only thread", async () => {
    const context = isolate();
    const results = await inside(
      context,
      `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
       return Promise.all([
         OpenSesameCore.testWebsitePattern({ uri: "(a+)+$", match: "regex" }, "example.com"),
         OpenSesameCore.testWebsitePattern({ uri: "*", match: "wildcard" }, "example.com"),
       ]);`,
    );
    expect(results).toEqual(["unavailable", "match"]);
  });

  it("searches and lists items with the same model the PWA uses", async () => {
    const context = isolate();
    const result = await inside(
      context,
      `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
       const item = OpenSesameCore.createItem("login", "Example Bank");
       return {
         found: OpenSesameCore.searchMatches(item, "bank"),
         missed: OpenSesameCore.searchMatches(item, "zzz"),
         host: OpenSesameCore.hostOf("https://www.example.com/login"),
         rows: OpenSesameCore.buildRows([item], [], new Set(), "").map((r) => r.type),
       };`,
    );
    expect(result).toEqual({
      found: true,
      missed: false,
      host: expect.stringContaining("example.com"),
      rows: ["item"],
    });
  });

  it("fails closed with no entropy source", async () => {
    const context = isolate(false);
    expect(
      await inside(
        context,
        `try { crypto.getRandomValues(new Uint8Array(4)); return "random"; }
         catch (e) { return e.message; }`,
      ),
    ).toMatch(/no entropy source/);
  });
});
