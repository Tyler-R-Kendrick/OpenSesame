export function offlineConsentValid(
  requested: readonly string[],
  issued: readonly string[] | null,
  refreshToken: string | undefined,
): boolean {
  return (
    !requested.includes("offline_access") ||
    issued?.includes("offline_access") === true ||
    refreshToken !== undefined
  );
}

export function requiredResourceScopes(
  requested: readonly string[],
): readonly string[] {
  return requested.filter((scope) => scope !== "offline_access");
}
