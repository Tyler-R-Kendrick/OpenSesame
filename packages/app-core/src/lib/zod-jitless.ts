/**
 * zod asks, the first time it parses an object schema, whether it may compile
 * that parser with `new Function`. The app's Content-Security-Policy forbids
 * eval (`script-src` has no `'unsafe-eval'`), so the answer is always no, but
 * asking is itself a CSP violation: every browser reports it, and Firefox logs
 * it as an error on every page that parses a schema. zod's `jitless` skips the
 * question.
 *
 * zod 4 keeps its configuration on `globalThis.__zod_globalConfig` and adopts
 * the object it finds there, so every copy shares it. Setting `jitless` on
 * that object before a schema module loads configures zod without importing
 * it into the boot path; set after, it still holds, because zod reads the same
 * object on every parse. `zod-jitless.test.ts` holds the installed zod to this.
 */

type ZodConfig = { jitless?: boolean };
type ZodScope = { __zod_globalConfig?: ZodConfig };

declare global {
  // zod's shared configuration (zod/v4/core/core.js).
  var __zod_globalConfig: ZodConfig | undefined;
}

export function zodJitless(scope: ZodScope = globalThis): void {
  scope.__zod_globalConfig ??= {};
  scope.__zod_globalConfig.jitless = true;
}
