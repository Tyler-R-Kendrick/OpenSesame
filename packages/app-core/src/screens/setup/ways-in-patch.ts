/**
 * One edit to the ways in (Settings → Endpoints): the identity API and the
 * sign-in methods. Everything a patch does not name is left as it stands.
 */
import {
  type OperatorIdp,
  type PagesSettings,
  signInMethods,
} from "../../lib/settings.js";

export type WaysInPatch = {
  builtin?: boolean;
  providers?: OperatorIdp[];
  identityApi?: string;
};

/** The settings `patch` leaves behind when applied to `current`. */
export function applyWaysInPatch(
  current: PagesSettings,
  patch: WaysInPatch,
): PagesSettings {
  const live = signInMethods(current);
  return {
    ...current,
    identityApi: patch.identityApi ?? current.identityApi,
    signIn: {
      builtin: patch.builtin ?? live.builtin,
      providers: patch.providers ?? live.providers,
    },
  };
}
