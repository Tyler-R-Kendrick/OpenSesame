/**
 * zod asks, the first time it builds an object schema, whether it may compile
 * that parser with `new Function`. Under the app's CSP the question is itself
 * a violation (Firefox logs it as an error), and setting zod's shared
 * `jitless` (`packages/app-core/src/lib/zod-jitless.ts`) answers it only if it
 * runs before the first schema is built.
 *
 * A module entry evaluates its static imports before its own body, in import
 * order, each import's own imports first. A chunk that builds a schema at load
 * time and is imported by the entry therefore runs before anything in the
 * entry's body, `boot.ts` included. So a page that loads zod must set jitless
 * before the first of zod's own code runs.
 */

const JITLESS = /__zod_globalConfig\.jitless=(?:!0|true)/;
// zod's constructors keep their names as strings through minification.
const ZOD = /["']\$ZodType["']/;

const CSP_META =
  /<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i;
const CONTENT = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * Whether a page's own Content-Security-Policy forbids eval: its script-src,
 * or default-src when there is none, leaves out 'unsafe-eval'. A page with no
 * policy may eval, so zod's question costs it nothing.
 */
export function forbidsEval(html) {
  const tag = html.match(CSP_META)?.[0];
  const content = tag?.match(CONTENT);
  if (!content) return false;
  const directives = new Map(
    (content[1] ?? content[2])
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
  const sources = directives.get("script-src") ?? directives.get("default-src");
  return sources !== undefined && !sources.includes("'unsafe-eval'");
}

/** The chunks a module entry evaluates, in ESM order: each import's own imports, then the import, then the entry. */
export function evaluationOrder(entry, staticImports) {
  const order = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of staticImports(file)) visit(dependency);
    order.push(file);
  };
  visit(entry);
  return order;
}

/**
 * Null when a page loads no zod, or sets jitless before the first of zod's
 * code it evaluates: in an earlier chunk, or earlier in zod's own chunk.
 * Otherwise the first chunk holding zod, and the chunk that sets the switch
 * (null when none does).
 */
export function jitlessOrderProblem(entry, staticImports, codeOf) {
  const order = evaluationOrder(entry, staticImports);
  const zod = order.findIndex((file) => ZOD.test(codeOf(file)));
  if (zod === -1) return null;
  const jitless = order.findIndex((file) => JITLESS.test(codeOf(file)));
  const code = codeOf(order[zod]);
  const inTime =
    jitless !== -1 &&
    (jitless < zod ||
      (jitless === zod && code.search(JITLESS) < code.search(ZOD)));
  if (inTime) return null;
  return {
    entry,
    zod: order[zod],
    jitless: jitless === -1 ? null : order[jitless],
  };
}
