import { describe, expect, it } from "vitest";
import {
  compareHygiene,
  isProductionRust,
  isProductionTypeScript,
  ledgerOf,
  rustBypasses,
  typeScriptBypasses,
} from "./log-hygiene.mjs";

describe("which files are production code", () => {
  it("counts package sources and skips tests and generated files", () => {
    expect(isProductionTypeScript("packages/cli/src/run.ts")).toBe(true);
    expect(
      isProductionTypeScript(
        "apps/browser-extension/entrypoints/background.ts",
      ),
    ).toBe(true);
    expect(isProductionTypeScript("packages/cli/src/run.test.ts")).toBe(false);
    expect(isProductionTypeScript("packages/cli/src/__tests__/a.ts")).toBe(
      false,
    );
    expect(isProductionTypeScript("packages/app-core/src/x.generated.ts")).toBe(
      false,
    );
    expect(isProductionTypeScript("apps/pages/scripts/build.mjs")).toBe(false);
    expect(isProductionRust("crates/gateway/src/lib.rs")).toBe(true);
    expect(isProductionRust("crates/gateway/tests/a.rs")).toBe(false);
    expect(isProductionRust("crates/gateway/src/routes/certs_tests.rs")).toBe(
      false,
    );
  });
});

describe("which JavaScript is production code", () => {
  it.each([
    "apps/pages/server/server.mjs",
    "packages/env-spec-bridge/bin/opensesame-env-parse.mjs",
    "packages/a/src/x.js",
    "packages/a/src/x.cjs",
    "packages/a/src/x.mts",
    "examples/agent/src/main.ts",
    "tools/mock-upstream-idp/src/cli.ts",
  ])("scans %s", (path) => {
    expect(isProductionTypeScript(path)).toBe(true);
  });

  it.each([
    "apps/pages/server/test/callback.test.mjs",
    "apps/pages/server/test/helper.mjs",
    "apps/pages/server/callback.d.mts",
    "apps/pages/server/connect-verify-targets.generated.mjs",
    "packages/a/src/tests/x.js",
    "packages/a/src/fixtures/x.mjs",
    "packages/a/src/x.spec.cjs",
    "packages/a/node_modules/x/src/y.js",
    "packages/a/dist/src/y.js",
    "apps/pages/scripts/build.mjs",
    "packages/a/scripts/emit.mjs",
  ])("skips %s", (path) => {
    expect(isProductionTypeScript(path)).toBe(false);
  });
});

describe("TypeScript bypasses", () => {
  it("counts a raw console call and a hand-built pino", () => {
    const text = 'console.log("x");\nconsole.warn(e);\nconst l = pino({});\n';
    expect(typeScriptBypasses("packages/a/src/x.ts", text)).toEqual({
      console: 2,
      pino: 1,
      stdio: 0,
    });
  });

  it("lets the sanctioned scrubbed fatal print through and pino live in observability", () => {
    expect(
      typeScriptBypasses(
        "packages/a/src/x.ts",
        "console.error(describeError(err));",
      ),
    ).toEqual({ console: 0, pino: 0, stdio: 0 });
    expect(
      typeScriptBypasses("packages/observability/src/logger.ts", "pino(opts)"),
    ).toEqual({
      console: 0,
      pino: 0,
      stdio: 0,
    });
  });

  it("does not mistake a method named pino or a comment word for a logger", () => {
    expect(
      typeScriptBypasses("packages/a/src/x.ts", "this.pino(x); // uses pino")
        .pino,
    ).toBe(0);
  });
});

const ts = (text, path = "packages/a/src/x.ts") =>
  typeScriptBypasses(path, text);

describe("TypeScript forms that went uncounted", () => {
  it("counts a console method passed as a value", () => {
    expect(ts("p.catch(console.error);").console).toBe(1);
    expect(ts("run(console.log, console.warn);").console).toBe(2);
    expect(ts("export function main(error = console.error) {}").console).toBe(
      1,
    );
  });

  it("counts console.table, console.dir and the other methods", () => {
    expect(ts("console.table(rows);").console).toBe(1);
    expect(ts("console.dir(obj);").console).toBe(1);
    expect(ts("console.group('x'); console.groupEnd();").console).toBe(2);
    expect(ts("console.assert(ok);").console).toBe(1);
  });

  it("counts a bracketed or computed console access", () => {
    expect(ts("console['log'](x);").console).toBe(1);
    expect(ts('console["error"](x);').console).toBe(1);
    expect(ts("console[level](x);").console).toBe(1);
    expect(ts("console?.log(x);").console).toBe(1);
    expect(ts("globalThis.console.log(x);").console).toBe(1);
  });

  it("counts a console destructured or aliased", () => {
    expect(ts("const { log } = console;").console).toBe(1);
    expect(ts("const out = console;").console).toBe(1);
  });

  it("counts a direct write to a standard stream", () => {
    expect(ts("process.stderr.write(line);").stdio).toBe(1);
    expect(ts("process.stdout.write(line);").stdio).toBe(1);
    expect(ts("process.stdout['write'](line);").stdio).toBe(1);
    expect(ts("fs.writeSync(2, line);").stdio).toBe(1);
    expect(ts("process.stdout.isTTY; process.stdin.read();").stdio).toBe(0);
  });

  it("counts an aliased or default-property hand-built pino", () => {
    expect(ts('import { pino as p } from "pino";\nconst l = p({});').pino).toBe(
      1,
    );
    expect(ts('import { default as make } from "pino";\nmake({});').pino).toBe(
      1,
    );
    expect(ts('import make from "pino";\nmake({});').pino).toBe(1);
    expect(ts('import * as lib from "pino";\nlib.default({});').pino).toBe(1);
    expect(ts('import pino from "pino";\npino.default({});').pino).toBe(1);
    expect(ts('const make = require("pino");\nmake({});').pino).toBe(1);
    expect(ts('const l = require("pino")({});').pino).toBe(1);
    expect(ts('const l = (await import("pino")).default({});').pino).toBe(1);
    expect(
      ts('import pinoHttp from "pino-http";\nuse(pinoHttp({}));').pino,
    ).toBe(1);
  });

  it("does not count a pino import that builds nothing", () => {
    expect(ts('import type { Logger } from "pino";').pino).toBe(0);
    expect(
      ts('import { pino as p } from "pino";\nexport type T = typeof p;').pino,
    ).toBe(0);
    expect(ts("this.p(x); other.default(x);").pino).toBe(0);
    expect(
      typeScriptBypasses(
        "packages/observability/src/x.ts",
        'import { pino as p } from "pino"; p({});',
      ).pino,
    ).toBe(0);
  });

  it("ignores a call named only in a comment", () => {
    expect(
      ts("// console.log(x)\n/* console.table(y) */\nconst a = 1;").console,
    ).toBe(0);
    expect(ts("// process.stdout.write(x)\n").stdio).toBe(0);
    expect(ts("/** pino({}) */ const a = 1;").pino).toBe(0);
  });

  it("does not let a URL or a regex hide the code after it", () => {
    expect(ts('const u = "https://x.test"; console.log(u);').console).toBe(1);
    expect(ts("const r = /\\/*\\//; console.log(r);").console).toBe(1);
    expect(ts("const t = `${a /* c */}//x`; console.warn(t);").console).toBe(1);
    expect(ts("const t = `${console.log(1)}`;").console).toBe(1);
  });
});

describe("Rust bypasses", () => {
  it("fails a subscriber with no scrubbing writer", () => {
    expect(
      rustBypasses("tracing_subscriber::fmt().with_env_filter(f).init();")
        .subscriber,
    ).toBe(1);
    expect(
      rustBypasses("tracing_subscriber::fmt().json().init()").subscriber,
    ).toBe(1);
  });

  it("passes the scrubbing writer and a test writer", () => {
    expect(
      rustBypasses(
        "tracing_subscriber::fmt().with_writer(ScrubMakeWriter::new(std::io::stdout, Format::Text)).init();",
      ).subscriber,
    ).toBe(0);
    expect(
      rustBypasses("tracing_subscriber::fmt().with_test_writer().try_init();")
        .subscriber,
    ).toBe(0);
  });
});

const sub = (text) =>
  rustBypasses(`use tracing_subscriber;\n${text}`).subscriber;

describe("Rust forms that went uncounted", () => {
  it("counts fmt::init and fmt::try_init", () => {
    expect(sub("tracing_subscriber::fmt::init();")).toBe(1);
    expect(sub("tracing_subscriber::fmt::try_init().ok();")).toBe(1);
    expect(sub("use tracing_subscriber::fmt;\nfmt::init();")).toBe(1);
  });

  it("counts an imported fmt() builder", () => {
    expect(sub("use tracing_subscriber::fmt;\nfmt().init();")).toBe(1);
    expect(
      sub("use tracing_subscriber::fmt;\nfmt().with_env_filter(f).try_init();"),
    ).toBe(1);
  });

  it("counts a registry with a fmt layer that is not scrubbed", () => {
    expect(
      sub("tracing_subscriber::registry().with(fmt::layer()).init();"),
    ).toBe(1);
    expect(
      sub("registry().with(tracing_subscriber::fmt::layer().json()).init();"),
    ).toBe(1);
    expect(
      sub("registry().with(fmt::layer().with_writer(std::io::stderr)).init();"),
    ).toBe(1);
    expect(sub("let l = fmt::Layer::new();")).toBe(1);
    expect(sub("let l = fmt::Layer::default().compact();")).toBe(1);
  });

  it("passes a registry whose fmt layer writes through the scrubber", () => {
    expect(
      sub(
        "registry().with(fmt::layer().with_writer(ScrubMakeWriter::new(std::io::stderr, Format::Text))).init();",
      ),
    ).toBe(0);
    expect(
      sub(
        "let make = ScrubMakeWriter::new(std::io::stderr, Format::Text);\nregistry().with(fmt::layer().with_writer(make)).init();",
      ),
    ).toBe(0);
  });

  it("counts the explicit builders", () => {
    expect(sub("tracing_subscriber::fmt::Subscriber::builder().init();")).toBe(
      1,
    );
    expect(sub("fmt::Subscriber::builder().finish();")).toBe(1);
    expect(sub("tracing_subscriber::FmtSubscriber::builder().init();")).toBe(1);
    expect(sub("FmtSubscriber::builder().with_max_level(l).finish();")).toBe(1);
    expect(
      sub(
        "FmtSubscriber::builder().with_writer(ScrubMakeWriter::new(std::io::stdout, Format::Json)).finish();",
      ),
    ).toBe(0);
  });

  it("is not satisfied by the exemption words in a comment or a string", () => {
    expect(
      sub("tracing_subscriber::fmt() // ScrubMakeWriter\n    .init();"),
    ).toBe(1);
    expect(
      sub(
        "tracing_subscriber::fmt()\n    /* with_test_writer */\n    .init();",
      ),
    ).toBe(1);
    expect(
      sub(
        "tracing_subscriber::fmt()\n    .with_writer(std::io::stderr) // ScrubMakeWriter\n    .init();",
      ),
    ).toBe(1);
    expect(
      sub(
        'tracing_subscriber::fmt().with_target(false).init(); let _ = "ScrubMakeWriter";',
      ),
    ).toBe(1);
    expect(sub('let _ = "tracing_subscriber::fmt::init()";')).toBe(0);
    expect(sub("// tracing_subscriber::fmt::init();\nfn main() {}")).toBe(0);
  });

  it("takes the last writer the chain sets", () => {
    expect(
      sub(
        "fmt().with_writer(ScrubMakeWriter::new(std::io::stderr, Format::Text)).with_writer(std::io::stderr).init();",
      ),
    ).toBe(1);
    expect(
      sub(
        "fmt().with_writer(std::io::stderr).with_writer(ScrubMakeWriter::new(std::io::stderr, Format::Text)).init();",
      ),
    ).toBe(0);
  });

  it("ignores a file that does not use tracing_subscriber and a fn named fmt", () => {
    expect(rustBypasses("fn fmt() {}\nfmt();")).toEqual({ subscriber: 0 });
    expect(sub("fn fmt() {}\nimpl X { fn f(&self) { self.fmt(); } }")).toBe(0);
  });
});

describe("the ratchet", () => {
  it("fails a new bypass and an unrecorded improvement, passes an unchanged ledger", () => {
    const recorded = { "a.ts": { console: 2 } };
    expect(compareHygiene({ "a.ts": { console: 2 } }, recorded)).toEqual({
      regressions: [],
      improvements: [],
    });
    expect(
      compareHygiene({ "a.ts": { console: 3 } }, recorded).regressions,
    ).toHaveLength(1);
    expect(
      compareHygiene({ "b.ts": { pino: 1 } }, recorded).regressions,
    ).toHaveLength(1);
    expect(
      compareHygiene({ "a.ts": { console: 1 } }, recorded).improvements,
    ).toHaveLength(1);
  });

  it("records only non-zero counts", () => {
    expect(
      ledgerOf({
        "a.ts": { console: 0, pino: 0 },
        "b.ts": { console: 2, pino: 0 },
      }),
    ).toEqual({
      "b.ts": { console: 2 },
    });
  });
});
