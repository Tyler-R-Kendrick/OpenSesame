/** Linux native compiler ownership: zombies cannot execute or write build scratch. */
import { readFile, readdir } from "node:fs/promises";
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));

export async function activeGroupMembers(group, except = 0) {
  const members = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === except) continue;
    let stat;
    try {
      stat = await readFile(`/proc/${name}/stat`, "utf8");
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error?.code)) continue;
      throw error;
    }
    const fields = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .match(/^([A-Za-z]) \d+ (\d+) (\d+) /);
    if (!fields) throw new Error("Cannot establish owned process-group state.");
    if (
      Number(fields[2]) === group &&
      Number(fields[3]) === group &&
      !["Z", "X", "x"].includes(fields[1])
    )
      members.push(Number(name));
  }
  return members;
}

export async function requireGroupDrained(group, timeoutMs = 2000) {
  if (!Number.isSafeInteger(group) || group <= 1) return;
  const deadline = performance.now() + timeoutMs;
  while ((await activeGroupMembers(group)).length) {
    if (performance.now() >= deadline) {
      const error = new Error(
        "Owned process group did not drain; its build scratch must be retained.",
      );
      error.code = "NATIVE_GROUP_DRAIN";
      throw error;
    }
    await pause(20);
  }
}
