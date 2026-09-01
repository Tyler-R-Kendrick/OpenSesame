/**
 * Whether this build is a development or test build.
 *
 * Vite sets `DEV` in `pnpm dev` and under Vitest. The registries use it for
 * faults that are always an authoring mistake and never a user's problem — a
 * target declared twice, an authored budget outgrown — so the mistake stops a
 * developer rather than quietly degrading what a person sees.
 */
export function inDevelopment(): boolean {
  return import.meta.env.DEV === true;
}
