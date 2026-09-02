import { escapeHtml } from "../middleware/security-headers.js";

export const AGENT_AUTH_CLAIM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

/**
 * Claim `return_to` is interpolated into an href. Only a same-origin path is
 * allowed: a scheme, a protocol-relative URL, or a backslash would send the
 * signed-in browser somewhere else.
 */
export function safeAgentAuthReturnTo(value: string): string {
  if (!value.startsWith("/")) return "/claim";
  if (value.startsWith("//") || value.includes("\\") || value.includes("://")) {
    return "/claim";
  }
  return value;
}

export function renderAgentAuthClaimPage(opts: {
  claimAttemptToken?: string;
  error?: string;
  done?: boolean;
}): string {
  if (opts.done) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Claim complete</title>
<meta name="robots" content="noindex"><style>body{font-family:sans-serif;margin:2rem;max-width:32rem}</style></head>
<body><h1>Registration claimed</h1><p>You can close this window. The agent will pick up the new credential.</p></body></html>`;
  }
  const token = escapeHtml(opts.claimAttemptToken ?? "");
  const error = opts.error
    ? `<p role="alert">${escapeHtml(opts.error)}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Claim agent registration</title>
<meta name="robots" content="noindex">
<style>body{font-family:sans-serif;margin:2rem;max-width:32rem}label{display:block;margin:.5rem 0}input{font:inherit;padding:.4rem}</style>
</head><body>
<h1>Claim this agent</h1>
<p>You are confirming that an agent may act with the scopes shown after you enter the code it gave you. OpenSesame will not merge accounts by email.</p>
${error}
<form method="post" action="/agent/identity/claim/complete">
<input type="hidden" name="claim_attempt_token" value="${token}">
<label>User code <input name="user_code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6}"></label>
<button type="submit">Confirm</button>
</form>
</body></html>`;
}

export function renderAgentAuthLoginPage(opts: {
  returnTo: string;
  publicUrl: string;
}): string {
  const returnTo = escapeHtml(safeAgentAuthReturnTo(opts.returnTo));
  const issuer = escapeHtml(opts.publicUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to claim</title>
<meta name="robots" content="noindex">
<style>body{font-family:sans-serif;margin:2rem;max-width:32rem}</style></head>
<body>
<h1>Sign in to continue</h1>
<p>Claiming an agent requires an authenticated OpenSesame session at <code>${issuer}</code>. Use your existing sign-in, then return here.</p>
<p><a href="/auth">Open sign-in</a></p>
<p>After signing in, continue to <a href="${returnTo}">the claim page</a>.</p>
</body></html>`;
}
