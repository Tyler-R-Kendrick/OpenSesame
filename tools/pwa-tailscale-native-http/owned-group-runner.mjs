/** Session leader stays alive until the actual command and its executable descendants stop. */
import { spawn } from "node:child_process";
import { activeGroupMembers } from "./process-group-state.mjs";

const [program, ...args] = process.argv.slice(2);
if (!program || !process.send)
  throw new Error("Owned group runner requires its parent IPC channel.");
let finishing = false;
let orphanForce;
const report = (value) =>
  new Promise((accept) => {
    if (!process.connected) return accept();
    process.send(value, () => accept());
  });
// TERM sent to the whole owned group must not kill its anchor before descendants drain.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.on("disconnect", () => {
  if (finishing) return;
  // If a higher layer is killed, the still-live session leader anchors this PGID.
  process.kill(-process.pid, "SIGTERM");
  orphanForce ??= setTimeout(() => process.kill(-process.pid, "SIGKILL"), 2000);
});
const env = { ...process.env };
env.NODE_CHANNEL_FD = undefined;
env.NODE_CHANNEL_SERIALIZATION_MODE = undefined;
const child = spawn(program, args, {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
let result;
try {
  result = await new Promise((accept) => {
    child.once("error", (error) => accept({ error }));
    child.once("exit", (code, signal) => accept({ code, signal }));
  });
  if (result.error)
    await report({
      kind: "spawn-error",
      code: result.error.code ?? "UNKNOWN",
      message: result.error.message,
    });
  else
    await report({
      kind: "command-exit",
      code: result.code,
      signal: result.signal,
    });
  let announced = false;
  const settling = performance.now() + 100;
  while ((await activeGroupMembers(process.pid, process.pid)).length) {
    if (!announced && performance.now() >= settling) {
      announced = true;
      await report({ kind: "descendants" });
    }
    await new Promise((accept) => setTimeout(accept, 20));
  }
  finishing = true;
  clearTimeout(orphanForce);
  if (process.connected) process.disconnect();
  process.exitCode = result.error || result.signal ? 1 : result.code;
} catch (error) {
  // Keep the anchor alive while parent-directed shutdown drains an uncertain group.
  await report({ kind: "descendants" });
  console.error(error.message);
  setInterval(() => {}, 1000);
}
