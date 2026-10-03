/**
 * The options page's credential form, validated before anything is stored.
 *
 * A credential is held for one origin, and the login profile that proves it
 * (`verify_login`) must live on that same origin: a profile that pointed
 * anywhere else would send the new password to a site the run was never armed
 * for. A selector that does not parse is refused here rather than at the first
 * step that needs it.
 */
import { drivable, withinOrigin } from "./origin";
import type { LoginProfile, VaultEntry } from "./vault";

export interface CredentialForm {
  origin: string;
  username: string;
  password: string;
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  signedInSelector: string;
  rejectedSelector: string;
}

export type FormError =
  | "origin"
  | "password"
  | "login_url"
  | "login_selector"
  | "login_incomplete";

export type FormResult =
  | { ok: true; entry: Omit<VaultEntry, "updatedAt"> }
  | { ok: false; error: FormError };

export const EMPTY_FORM: CredentialForm = {
  origin: "",
  username: "",
  password: "",
  loginUrl: "",
  usernameSelector: "",
  passwordSelector: "",
  submitSelector: "",
  signedInSelector: "",
  rejectedSelector: "",
};

export function entryFromForm(
  form: CredentialForm,
  parses: (selector: string) => boolean,
): FormResult {
  const origin = form.origin.trim();
  if (!drivable(origin)) return { ok: false, error: "origin" };
  if (form.password.length === 0) return { ok: false, error: "password" };
  const selectors = [
    form.usernameSelector,
    form.passwordSelector,
    form.submitSelector,
    form.signedInSelector,
    form.rejectedSelector,
  ].map((value) => value.trim());
  const profileGiven = [form.loginUrl.trim(), ...selectors].some(
    (value) => value.length > 0,
  );
  const base = { origin, username: form.username, password: form.password };
  if (!profileGiven) return { ok: true, entry: base };
  const [username, password, submit, signedIn, rejected] = selectors;
  if (!password || !submit || !signedIn || !form.loginUrl.trim()) {
    return { ok: false, error: "login_incomplete" };
  }
  if (!withinOrigin(form.loginUrl.trim(), origin)) {
    return { ok: false, error: "login_url" };
  }
  if (selectors.some((selector) => selector.length > 0 && !parses(selector))) {
    return { ok: false, error: "login_selector" };
  }
  const login: LoginProfile = {
    url: form.loginUrl.trim(),
    passwordSelector: password,
    submitSelector: submit,
    signedInSelector: signedIn,
  };
  if (username) login.usernameSelector = username;
  if (rejected) login.rejectedSelector = rejected;
  return { ok: true, entry: { ...base, login } };
}
