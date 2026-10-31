// Run as a classic script before the module graph: a dependency can construct
// a Zod schema before host/boot.ts's body gets to seed this configuration.
// The page's CSP forbids even the library's caught probe for new Function.
globalThis.__zod_globalConfig ??= {};
globalThis.__zod_globalConfig.jitless = true;
