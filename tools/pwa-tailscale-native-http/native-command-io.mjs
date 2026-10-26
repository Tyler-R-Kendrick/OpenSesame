/** Keep compiler diagnostics separate from machine-readable audit output. */
import { open } from "node:fs/promises";
import { join } from "node:path";

export async function openNativeCommandLogs({
  logs,
  name,
  interrupted,
  stdoutPath,
}) {
  const log = await open(join(logs, `${name}.log`), "w");
  try {
    if (interrupted)
      throw new Error("Private compile interrupted before child start.");
    const stdout = stdoutPath ? await open(stdoutPath, "wx", 0o600) : null;
    return { log, stdout };
  } catch (error) {
    await log.close();
    throw error;
  }
}
