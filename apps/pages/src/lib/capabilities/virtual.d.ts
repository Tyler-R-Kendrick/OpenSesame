/**
 * Build-time virtual modules provided by `scripts/capability-compose-plugin.mjs`
 * (S07). They exist only inside a Vite build or dev server; unit tests inject
 * their contents through `loaderSeams.moduleTable` and `storeSeams.distribution`
 * and never evaluate these specifiers.
 */

declare module "virtual:opensesame-capability-modules" {
  export const MODULE_TABLE: Readonly<
    Record<
      string,
      () => Promise<{
        capabilityRuntime: import("./runtime-contract.js").CapabilityRuntime;
      }>
    >
  >;
}

declare module "virtual:opensesame-distribution" {
  // biome-ignore format: wrapping an import() type across lines is not valid TypeScript
  export const DISTRIBUTION: import("@opensesame/capability-composition").DistributionContract;
}
