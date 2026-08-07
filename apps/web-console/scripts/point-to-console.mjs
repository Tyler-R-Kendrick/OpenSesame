#!/usr/bin/env node
/**
 * web-console is intentionally a stub. Operators should use apps/console.
 */
const mode = process.argv.includes("--build")
  ? "build"
  : process.argv.includes("--check")
    ? "check"
    : "dev";

const msg = `[web-console] Stub package (${mode}).
Use the Identity console instead:

  pnpm --filter @opensesame/console dev

That app covers sign-in, Authorize CLI, Claim ownership, and Task access.
`;

if (mode === "check") {
  console.log(msg.trim());
  process.exit(0);
}

console.error(msg);
process.exit(mode === "build" ? 0 : 0);
