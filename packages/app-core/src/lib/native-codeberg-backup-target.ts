/** Optional saved Contents target; account-only OAuth connections remain valid. */
import { SecretBackendError } from "./secret-backends/types.js";
export type NativeCodebergBackupTarget = Readonly<{
  owner: string;
  repo: string;
  branch: string;
}>;
export function nativeCodebergTargetPath(target: NativeCodebergBackupTarget) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(target.owner) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(target.repo) ||
    !target.branch ||
    target.branch.length > 255 ||
    /[\s~^:?*\[\\]/.test(target.branch) ||
    Array.from(target.branch).some(
      (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127,
    ) ||
    target.branch.includes("..") ||
    target.branch.includes("@{") ||
    target.branch
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          part.endsWith(".") ||
          part.endsWith(".lock"),
      )
  )
    throw new SecretBackendError(
      "configuration",
      "Use a repository owner, name and existing branch for the Codeberg backup.",
    );
  return `/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}
export function nativeCodebergBackupTarget(
  parameters: Readonly<Record<string, string>>,
): NativeCodebergBackupTarget | null {
  if (
    Object.keys(parameters).some(
      (key) => !["backup_owner", "backup_repo", "backup_branch"].includes(key),
    )
  )
    throw new SecretBackendError(
      "configuration",
      "Unknown Codeberg backup parameter.",
    );
  const target = {
    owner: (parameters.backup_owner ?? "").trim(),
    repo: (parameters.backup_repo ?? "").trim(),
    branch: (parameters.backup_branch ?? "").trim(),
  };
  if (!target.owner && !target.repo && !target.branch) return null;
  nativeCodebergTargetPath(target);
  return Object.freeze(target);
}
