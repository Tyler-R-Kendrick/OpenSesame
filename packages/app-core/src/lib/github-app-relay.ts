import { maybePage } from "../ports.js";
import { connectCallbackBase } from "./connect-callback.js";

/**
 * Legacy relay destination for repository management and forge backups.
 * App conversion, ownership and installation discovery use GitHub directly.
 * Remaining relay callers migrate in separate slices.
 */
export function githubAppRelayBase(
  origin = maybePage()?.location.origin ?? "",
): string {
  const local = origin.replace(/\/+$/u, "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(local)) {
    return local;
  }
  const configured = connectCallbackBase().replace(/\/+$/u, "");
  if (configured !== "") return configured;
  return local;
}

/** Static, same-origin callback. Its marker keeps GitHub's code out of OIDC boot. */
export function githubAppRedirectUrl(
  returnTo: string,
  origin = maybePage()?.location.origin ?? "",
): string {
  const base = new URL(origin);
  const callback = new URL(returnTo, base);
  if (
    !/^https?:$/.test(base.protocol) ||
    callback.origin !== base.origin ||
    callback.username ||
    callback.password ||
    callback.hash
  )
    throw new Error(
      "GitHub registration must return to this app without a URL fragment.",
    );
  for (const key of [
    "code",
    "state",
    "error",
    "error_description",
    "github_app_code",
    "github_app_state",
  ])
    callback.searchParams.delete(key);
  callback.searchParams.set("github_app", "claim");
  return callback.toString();
}
