// Imports the actual packed product exports and its fixed companion loader.
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureInstalledNativeNodeWorker } from "@opensesame/app-core/node/native-companion-installation.js";
import { parseArgs, runCli } from "@opensesame/cli";
import { isFunction } from "@opensesame/os-domain";
if (!isFunction(parseArgs) || !isFunction(runCli))
  throw new Error("Actual packed CLI exports unavailable.");
const state = await mkdtemp(join(tmpdir(), "opensesame-packed-original-"));
const key = randomBytes(32);
let worker:
  | Awaited<ReturnType<typeof captureInstalledNativeNodeWorker>>
  | undefined;
let failure: unknown;
let rejected = false;
try {
  if (process.platform !== "win32") await chmod(state, 0o700);
  await writeFile(join(state, "at-rest.key"), `${key.toString("base64")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  key.fill(0);
  worker = await captureInstalledNativeNodeWorker(state, () => {});
  worker.check();
  await worker.close();
  worker = undefined;
} catch (error) {
  failure = error;
  rejected = true;
}
key.fill(0);
const cleanup: unknown[] = [];
try {
  await worker?.close();
} catch (error) {
  cleanup.push(error);
}
try {
  await rm(state, { recursive: true, force: false });
} catch (error) {
  cleanup.push(error);
}
if (cleanup.length)
  throw new AggregateError(
    rejected ? [failure, ...cleanup] : cleanup,
    "Actual packed probe cleanup failed.",
  );
if (rejected) throw failure;
