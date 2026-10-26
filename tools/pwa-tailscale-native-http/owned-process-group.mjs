/** Only a live supervisor may be signalled; after it exits, group IDs are observed, never killed. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireGroupDrained } from "./process-group-state.mjs";
export const INNER_GROUP_GRACE_MS = 1000;
export const OUTER_GROUP_GRACE_MS = 5000;

async function messageDecoder() {
  const z = await import("zod/v4/mini");
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("spawn-error"),
      code: z.string(),
      message: z.string(),
    }),
    z.object({
      kind: z.literal("command-exit"),
      code: z.nullable(z.int()),
      signal: z.nullable(z.string()),
    }),
    z.object({ kind: z.literal("descendants") }),
  ]);
}
function liveAnchor(state) {
  return (
    !state.retired &&
    Number.isSafeInteger(state.child.pid) &&
    state.child.pid > 1 &&
    state.child.exitCode === null &&
    state.child.signalCode === null
  );
}
function signalAnchorGroup(state, signal) {
  if (!liveAnchor(state)) return;
  try {
    process.kill(-state.child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH")
      state.failure = "Could not signal owned command group.";
  }
}
export function stopOwnedCommand(state, reason) {
  state.stopReason ??= reason;
  state.observation.reason = state.stopReason;
  if (!liveAnchor(state)) return;
  signalAnchorGroup(state, "SIGTERM");
  state.force ??= setTimeout(
    () => signalAnchorGroup(state, "SIGKILL"),
    state.graceMs,
  );
}
function receive(state, decoder, value) {
  const decoded = decoder.safeParse(value);
  if (!decoded.success) {
    state.failure = "Owned command supervisor returned invalid status.";
    stopOwnedCommand(state, "protocol");
    return;
  }
  const message = decoded.data;
  if (message.kind === "spawn-error") {
    state.spawnError = Object.assign(new Error(message.message), {
      code: message.code,
    });
    state.observation.spawnCode = message.code;
    state.observation.reason = "spawn";
  } else if (message.kind === "command-exit") {
    state.observation.exitCode = message.code;
    state.observation.signal = message.signal;
  } else stopOwnedCommand(state, "descendant");
}
async function completed(state, code, signal) {
  state.anchorSignal = signal;
  clearTimeout(state.force); // No timer may signal a numeric group after its anchor exits.
  try {
    await requireGroupDrained(state.child.pid);
    state.drained = true;
    if (state.spawnError) throw state.spawnError;
    if (code !== 0 || signal || state.stopReason || state.failure)
      throw new Error(state.failureMessage);
  } finally {
    state.retired = true;
  }
}
export async function startOwnedCommand({
  program,
  args,
  cwd,
  env,
  stdio,
  observation,
  graceMs,
  failureMessage,
}) {
  const decoder = await messageDecoder();
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./owned-group-runner.mjs", import.meta.url)),
      program,
      ...args,
    ],
    {
      cwd,
      env,
      detached: true,
      stdio: [...stdio, "ipc"],
    },
  );
  const state = {
    child,
    observation,
    graceMs,
    failureMessage,
    force: null,
    stopReason: null,
    spawnError: null,
    failure: "",
    retired: false,
    drained: false,
    anchorSignal: null,
  };
  child.on("message", (value) => receive(state, decoder, value));
  state.done = new Promise((accept, reject) => {
    child.once("error", (error) => {
      state.spawnError = error;
      state.observation.reason = "spawn";
      state.observation.spawnCode = error.code;
      completed(state, null, null).then(accept, reject);
    });
    child.once("exit", () => clearTimeout(state.force));
    child.once("close", (code, signal) =>
      completed(state, code, signal).then(accept, reject),
    );
  });
  // The owning caller awaits this promise; an early exit must not become an unhandled rejection.
  state.done.catch(() => {});
  return state;
}
