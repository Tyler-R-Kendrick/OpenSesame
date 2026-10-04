import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A raw `sql` fragment must not bind a `Date`.
 *
 * Drizzle replaces postgres-js's timestamptz serializer with the identity
 * function, because its own column mappers hand the driver ISO strings. A
 * `Date` interpolated into sql`` skips those mappers, reaches postgres-js
 * unconverted and throws `ERR_INVALID_ARG_TYPE` — on a real server only: PGlite
 * binds a `Date` happily, which is why this passed every in-process suite while
 * `runCleanupTick` threw on every tick in production.
 *
 * The comparison operators (`lte`, `gt`, `gte`, `lt`) run the value through the
 * column's mapper and work on both engines. This is the cheap tripwire that
 * needs no server; the proof is the same suites run against a real one
 * (`DATABASE_URL=… pnpm --filter @opensesame/database test:postgres`, wired into
 * CI), which `createPgTestContext` switches to by itself.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/** Names that read as a time when they stand alone, not as a column reference. */
const BARE_TIME_NAME =
  /^(?:now|date|when|at|since|until|before|after|cutoff|deadline|[A-Za-z]*(?:At|Date|Time|Ts|Deadline))$/u;

function dateBindingsInRawSql(source: string): string[] {
  const found: string[] = [];
  const template = /\bsql(?:<[^>]*>)?`((?:[^`\\]|\\.)*)`/gu;
  for (const [, body = ""] of source.matchAll(template)) {
    for (const [, raw = ""] of body.matchAll(/\$\{([^}]*)\}/gu)) {
      const expression = raw.trim();
      const bare = !expression.includes(".") && !expression.includes("(");
      if (
        /\bnew Date\b|\.toISOString\b/u.test(expression) ||
        (bare && BARE_TIME_NAME.test(expression))
      ) {
        found.push(expression);
      }
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("raw sql fragments never bind a Date", () => {
  it("recognises the shape that broke on a real server", () => {
    expect(dateBindingsInRawSql("sql`${t.availableAt} <= ${now}`")).toEqual([
      "now",
    ]);
    expect(dateBindingsInRawSql("sql`${t.expiresAt} > ${new Date()}`")).toEqual(
      ["new Date()"],
    );
    expect(dateBindingsInRawSql("sql`${t.attempts} + 1`")).toEqual([]);
    expect(dateBindingsInRawSql("sql`${rowOwnerKey} = ${ownerKey}`")).toEqual(
      [],
    );
  });

  it("holds across every repository and store", () => {
    const offenders = sourceFiles(srcDir).flatMap((file) =>
      dateBindingsInRawSql(readFileSync(file, "utf8")).map(
        (expression) => `${relative(srcDir, file)}: \${${expression}}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
