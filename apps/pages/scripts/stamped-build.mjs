/**
 * Run a build with the deployment profile stamped into
 * `public/security-profile.json`, and put the file back to its tracked default whether the
 * build succeeds, fails or is interrupted. The profile is baked into the
 * bundle from that tracked file, so a build for another origin has to write it;
 * a `&&` chain that restores it at the end leaves the tracked file dirty
 * whenever a step before the end fails.
 *
 *   PAGES_DEPLOYMENT_PROFILE=… PAGES_CANONICAL_ORIGIN=… \
 *     node scripts/stamped-build.mjs '<shell command>'
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { securityProfile } from "./security-profile.mjs";

const render = (profile) => `${JSON.stringify(profile, null, 2)}\n`;

/**
 * Write `profile` into `file`; the returned function puts the tracked default
 * back. The default, not what was read: a file a crashed run left stamped
 * would otherwise be taken for the original and put back stamped.
 */
export function stamp(file, profile) {
  writeFileSync(file, render(profile));
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    writeFileSync(file, render(securityProfile({})));
  };
}

function main(command) {
  const file =
    process.env.STAMP_PROFILE_FILE ??
    new URL("../public/security-profile.json", import.meta.url);
  const restore = stamp(file, securityProfile(process.env));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      restore();
      process.exit(130);
    });
  }
  const child = spawn(command, { shell: true, stdio: "inherit" });
  child.on("error", () => {
    restore();
    process.exit(1);
  });
  child.on("exit", (code) => {
    restore();
    process.exit(code ?? 1);
  });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const command = process.argv[2];
  if (!command) {
    console.error("usage: stamped-build.mjs '<shell command>'");
    process.exit(2);
  }
  main(command);
}
