// Runs lanes of commands side by side. A lane's commands run in order and the
// lane stops at its first failure; the lanes do not wait for each other, and
// the result is the worst of them. The typecheck and the unit tests of a diff
// do not depend on each other, and one waits on the CPU where the other waits
// on the disk and the runner's start-up.

import { spawn } from "node:child_process";

/** @returns {Promise<number>} the command's exit status (1 when it cannot start) */
function run({ command, args, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      cwd,
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("close", (status) => resolve(status ?? 1));
  });
}

/**
 * @param {{ command: string, args: string[], cwd?: string, note?: string }[][]} lanes
 * @returns {Promise<number>} 0 when every lane passed
 */
export async function runLanes(lanes) {
  const statuses = await Promise.all(
    lanes.map(async (lane) => {
      for (const step of lane) {
        if (step.note) console.error(`unit tests: ${step.note}`);
        const status = await run(step);
        if (status !== 0) return status;
      }
      return 0;
    }),
  );
  return statuses.find((status) => status !== 0) ?? 0;
}
