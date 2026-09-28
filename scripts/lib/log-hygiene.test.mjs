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

describe("TypeScript bypasses", () => {
  it("counts a raw console call and a hand-built pino", () => {
    const text = 'console.log("x");\nconsole.warn(e);\nconst l = pino({});\n';
    expect(typeScriptBypasses("packages/a/src/x.ts", text)).toEqual({
      console: 2,
      pino: 1,
    });
  });

  it("lets the sanctioned scrubbed fatal print through and pino live in observability", () => {
    expect(
      typeScriptBypasses(
        "packages/a/src/x.ts",
        "console.error(describeError(err));",
      ),
    ).toEqual({ console: 0, pino: 0 });
    expect(
      typeScriptBypasses("packages/observability/src/logger.ts", "pino(opts)"),
    ).toEqual({
      console: 0,
      pino: 0,
    });
  });

  it("does not mistake a method named pino or a comment word for a logger", () => {
    expect(
      typeScriptBypasses("packages/a/src/x.ts", "this.pino(x); // uses pino")
        .pino,
    ).toBe(0);
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
