import { createHash } from "node:crypto";

/** Stable id for the interactive terminal session (1Password-style app integration). */
export function deriveTerminalSessionId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OPENSESAME_CLI_TERMINAL_SESSION_ID;
  if (explicit?.trim()) return explicit.trim();
  const tty = env.OPENSESAME_CLI_TTY ?? "";
  const shellPid = env.OPENSESAME_CLI_SHELL_PID ?? "";
  const payload = `${tty}\0${shellPid}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}
