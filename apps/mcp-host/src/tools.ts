export const hostTools = ["daemon_status", "host_ready"] as const;

export function assertsNoSecretTools(names: readonly string[]): void {
  if (names.some((n) => /secret|materialize/i.test(n))) {
    throw new Error("secret_tools_forbidden");
  }
}
