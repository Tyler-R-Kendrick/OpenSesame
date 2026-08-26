/**
 * Read the continuation URL out of the interstitial hop page.
 *
 * A federated/oauth2/SAML start — and the login/consent finishers — answer a
 * form POST with a 200 meta-refresh page instead of a 303: Chromium enforces
 * CSP `form-action 'self'` against every redirect of a form submission, so a
 * chain that leaves this origin would be silently refused in real browsers
 * (see renderHopPage). Tests that used to follow the Location header follow
 * the refresh target instead.
 */
export async function hopUrl(res: Response): Promise<string> {
  if (res.status !== 200) {
    throw new Error(`expected interstitial hop page, got ${res.status}`);
  }
  const html = await res.text();
  const match = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/);
  if (!match?.[1]) {
    throw new Error("hop page carries no refresh target");
  }
  // `&amp;` decodes last, or an escaped `&amp;lt;` would double-decode.
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
