/**
 * zod 4 asks, the first time it builds an object schema, whether it may
 * compile with `new Function`, and under the app's CSP the question is itself
 * a violation (`packages/app-core/src/lib/zod-jitless.ts`). A call to
 * zodJitless() in boot.ts runs too late, because the entry's static imports
 * evaluate before its body and any of them may build a schema as it loads.
 *
 * So the chunk that holds zod 4's core switches it off first: this intro runs
 * before that chunk's own code. Every chunk that builds a schema depends on
 * that chunk, so none can run before the switch, whatever order a page loads
 * its chunks in. It is the same assignment zodJitless() makes, on the shared
 * object zod adopts.
 */

const ZOD_CORE = /\/node_modules\/zod\/v4\/core\//;
const INTRO =
  "globalThis.__zod_globalConfig??={};globalThis.__zod_globalConfig.jitless=true;";

/** Rollup `output.intro`: the switch for a chunk holding zod 4's core, nothing for any other. */
export function zodJitlessIntro(chunk) {
  return chunk.moduleIds.some((id) => ZOD_CORE.test(id.replaceAll("\\", "/")))
    ? INTRO
    : "";
}
