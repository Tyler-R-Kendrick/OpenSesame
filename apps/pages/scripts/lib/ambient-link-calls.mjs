/**
 * Whether a request is one of the identity-linking, history or join API
 * calls ambient SSO must never make on its own. A built chunk of the app's
 * own origin can carry the same word in its file name (a history module's
 * chunk did), and trapping it failed the app's own boot — so this origin's
 * static assets are never one.
 */
export function isLinkCall(url, origin, base) {
  if (url.origin === origin && url.pathname.startsWith(`${base}assets/`))
    return false;
  return /link-identities|federated-session|history|claimProvisional/i.test(
    url.pathname,
  );
}
