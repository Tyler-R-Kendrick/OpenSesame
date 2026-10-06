export function canPreviewVaultPath(
  pathname: string,
  itemId: string | undefined,
  workflow: string | null,
): boolean {
  if (workflow === "password") return false;
  return (
    pathname === "/vault" ||
    (itemId !== undefined && !pathname.endsWith("/edit"))
  );
}
