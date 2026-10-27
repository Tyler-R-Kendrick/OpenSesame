import type { PasswordResetDependencies } from "./password-reset-command.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";

export async function dispatchPasswordReset(
  command: PasswordResetCommand,
  deps: PasswordResetDependencies | undefined,
): Promise<number> {
  const { runPasswordReset } = await import("./password-reset-command.js");
  return runPasswordReset(command, deps);
}
