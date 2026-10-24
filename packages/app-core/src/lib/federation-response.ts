import { page } from "../ports.js";

/** True when the current URL looks like an upstream sending the browser back. */
export function hasAuthResponse(search = page().location.search): boolean {
  const params = new URLSearchParams(search);
  if (params.has("github_app") || params.has("github_app_code")) return false;
  return params.has("code") || params.has("error");
}
