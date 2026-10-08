import { builtinEnvironments } from "vitest/runtime";

// This persistence fixture combines the page's actual jsdom session storage
// with Node's disk adapter and SQLite locks. On Node 22, SQLite is a
// prefix-only builtin absent from builtinModules: Vitest's client transform
// tries to bundle it. SSR transforms load genuine Node builtins while keeping
// the complete built-in jsdom setup and teardown.
export default {
  ...builtinEnvironments.jsdom,
  name: "durable-page",
  viteEnvironment: "ssr",
};
