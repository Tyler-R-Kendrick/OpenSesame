/** Optional GitLab V4 project/branch contract; never an arbitrary endpoint. */
import { z } from "zod";
import { nativeApiHeaders } from "./native-api-auth.js";
import { nativeApiHttp } from "./native-api-http.js";
import type { NativeApiTarget } from "./native-api-target.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { SecretBackendError } from "./secret-backends/types.js";
import { zodJitless } from "./zod-jitless.js";
zodJitless();
export type NativeGitlabBackupTarget = Readonly<{
  project: string;
  branch: string;
}>;
export function nativeGitlabTargetPath(target: NativeGitlabBackupTarget) {
  if (
    !target.project ||
    target.project.length > 256 ||
    !target.project
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) &&
          !part.endsWith(".") &&
          !part.endsWith(".git"),
      ) ||
    target.branch === "@" ||
    target.branch.startsWith("-") ||
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
      "Use a GitLab project and existing branch for the encrypted backup.",
    );
  return `/api/v4/projects/${encodeURIComponent(target.project)}`;
}
export function nativeGitlabBackupTarget(
  parameters: Readonly<Record<string, string>>,
): NativeGitlabBackupTarget | null {
  if (
    Object.keys(parameters).some(
      (key) => !["backup_project", "backup_branch"].includes(key),
    )
  )
    throw new SecretBackendError(
      "configuration",
      "Unknown GitLab backup parameter.",
    );
  const target = {
    project: (parameters.backup_project ?? "").trim(),
    branch: (parameters.backup_branch ?? "").trim(),
  };
  if (!target.project && !target.branch) return null;
  nativeGitlabTargetPath(target);
  return Object.freeze(target);
}
const project = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  path_with_namespace: z.string(),
  archived: z.literal(false),
  repository_access_level: z.enum(["enabled", "private"]),
});
const branch = z.object({
  name: z.string(),
  can_push: z.literal(true),
  commit: z.object({ id: z.string().regex(/^[a-f0-9]{40}$/) }),
});
export async function verifyNativeGitlabBackupTarget(
  target: NativeApiTarget,
  credentials: Record<string, string>,
  transport: NativeProviderTransport,
) {
  if (target.providerId !== "gitlab") return;
  const selected = nativeGitlabBackupTarget(target.parameters);
  if (!selected) return;
  const base = nativeGitlabTargetPath(selected);
  const headers = nativeApiHeaders(target, credentials);
  const request = (path: string) =>
    nativeApiHttp(
      {
        url: `https://gitlab.com${path}`,
        method: "GET",
        headers,
        signal: transport.signal,
      },
      transport,
    );
  const result = project.safeParse(await request(base));
  if (!result.success)
    throw new SecretBackendError(
      "response",
      "GitLab did not prove the backup project.",
    );
  const body = result.data;
  if (
    selected.project !== String(body.id) &&
    selected.project !== body.path_with_namespace
  )
    throw new SecretBackendError(
      "response",
      "GitLab returned a different backup project.",
    );
  const head = branch.safeParse(
    await request(
      `${base}/repository/branches/${encodeURIComponent(selected.branch)}`,
    ),
  );
  if (!head.success || head.data.name !== selected.branch)
    throw new SecretBackendError(
      "response",
      "GitLab returned a different backup branch.",
    );
}
