/** GitHub-approved personal tokens authenticate directly to its fixed browser API. */
import { z } from "zod";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import { nativeBrowserApiPolicy } from "./native-browser-policy.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export const nativeGithubOrigin = "https://api.github.com";
const accountSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
  type: z.literal("User"),
});
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z
    .string()
    .min(3)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/),
  html_url: z.string().url(),
});
export function assertNativeGithubBrowser(): void {
  const policy = nativeBrowserApiPolicy("github");
  if (!policy.available)
    throw new Error(policy.reason ?? "GitHub does not permit this browser API");
}
export function nativeGithubToken(value: string): string {
  const token = value.trim();
  if (!token || token.length > 16384 || !/^[!-~]+$/.test(token))
    throw new Error("Enter a valid GitHub personal access token");
  return token;
}
function githubRequest(path: string, token: string) {
  return {
    url: `${nativeGithubOrigin}${path}`,
    method: "GET" as const,
    headers: new Headers({
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
  };
}
export async function readNativeGithubAccount(
  token: string,
  transport: NativeProviderTransport,
) {
  assertNativeGithubBrowser();
  const body = await nativeApiHttp(githubRequest("/user", token), transport);
  const parsed = accountSchema.safeParse(body);
  if (!parsed.success) throw new NativeApiError("response");
  safeProviderText(parsed.data.login, { api_key: token });
  return { id: String(parsed.data.id), label: parsed.data.login };
}
export async function readNativeGithubRepositories(
  token: string,
  transport: NativeProviderTransport,
) {
  assertNativeGithubBrowser();
  const body = await nativeApiHttp(
    githubRequest("/user/repos?per_page=100&sort=updated", token),
    transport,
  );
  const parsed = z.array(repositorySchema).max(100).safeParse(body);
  if (!parsed.success) throw new NativeApiError("response");
  return parsed.data.map((repository) => {
    const label = safeProviderText(repository.full_name, { api_key: token });
    const url = `https://github.com/${label}`;
    if (repository.html_url !== url) throw new NativeApiError("response");
    return { id: String(repository.id), label, url };
  });
}
