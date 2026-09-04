import { escapeHtml } from "../middleware/security-headers.js";

export const AGENT_AUTH_CLAIM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

/** First-party public client for the claim-login authorize request. */
export const AGENT_AUTH_OAUTH_CLIENT_ID = "opensesame-agent-auth";

export function agentAuthClaimRedirectUri(issuer: string): string {
  return `${issuer.replace(/\/+$/u, "")}/claim/resume`;
}

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

const CLAIM_ERROR_COPY: Record<string, string> = {
  invalid_user_code:
    "That code does not match. Ask the agent for the current 6 digits and try again.",
  expired_token:
    "This claim link has expired. Start the ceremony again from the agent.",
  claimed_or_in_flight:
    "This registration is already claimed. You can close this window.",
  invalid_request:
    "This claim link is not valid. Start the ceremony again from the agent.",
  unauthorized: "Sign in first, then return to enter the code.",
};

export function claimErrorCopy(error: string): string {
  return CLAIM_ERROR_COPY[error] ?? error;
}

const SHELL_CSS = `:root{color-scheme:light;--canvas:#fafafa;--ink:#171717;--ink-2:#5c5c5c;--line:#e7e7e7;--accent:#0d7268;--err:#b32424;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,sans-serif;--radius:2px}
*{box-sizing:border-box}
html,body{margin:0;background:var(--canvas);color:var(--ink)}
body{font-family:var(--sans);font-size:0.9375rem;line-height:1.5;min-height:100dvh;display:flex;flex-direction:column}
.wrap{width:min(32rem,calc(100% - 2rem));margin:2.5rem auto 3rem}
.brand{display:flex;align-items:center;gap:0.55rem;font-family:var(--mono);font-size:0.75rem;font-weight:600;letter-spacing:-0.02em;margin:0 0 1.5rem}
.mark{flex:none}
h1{font-family:var(--mono);font-size:1.4rem;font-weight:600;letter-spacing:-0.021em;line-height:1.2;margin:0 0 0.55rem}
.lede{color:var(--ink-2);margin:0 0 1.25rem;max-width:36em}
.record{border-top:1px solid var(--line);margin:0 0 1.25rem;padding:0.65rem 0}
.record dt{font-family:var(--mono);font-size:0.75rem;font-weight:600;color:var(--ink-2);margin:0}
.record dd{margin:0.15rem 0 0.7rem;font-family:var(--mono);font-size:0.8125rem}
.record dd:last-child{margin-bottom:0}
.field{display:grid;grid-template-columns:6.5rem 1fr;gap:0.4rem 0.75rem;align-items:baseline;border-bottom:1px solid var(--line);padding:0.35rem 0 0.45rem;margin:0 0 1rem}
.field label{font-family:var(--mono);font-size:0.75rem;font-weight:600}
.field input{font-family:var(--mono);font-size:1.0625rem;letter-spacing:0.18em;border:0;border-radius:0;background:transparent;color:var(--ink);padding:0.2rem 0;width:100%;caret-color:var(--ink)}
.field input:focus{outline:none}
.field:focus-within{border-bottom-color:var(--ink);border-bottom-width:2px;padding-bottom:calc(0.45rem - 1px)}
.hint{font-family:var(--mono);font-size:0.75rem;color:var(--ink-2);margin:-0.4rem 0 1.1rem}
.alert{color:var(--err);font-family:var(--mono);font-size:0.8125rem;margin:0 0 1rem}
.go-row{display:flex;align-items:center;gap:0.6rem;margin:1.25rem 0 0}
.go{appearance:none;display:grid;place-items:center;width:2.5rem;height:2.5rem;flex:none;border:0;border-radius:var(--radius);background:var(--ink);color:var(--canvas);cursor:pointer;text-decoration:none}
.go:hover{background:color-mix(in srgb,var(--ink) 82%,var(--canvas))}
.go:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.go-verb{font-family:var(--mono);font-size:0.8125rem;color:var(--ink-2)}
.mute{font-family:var(--mono);font-size:0.75rem;color:var(--ink-2);margin:1.5rem 0 0}
a.inline{color:var(--ink);text-underline-offset:0.18em}
::selection{background:var(--ink);color:var(--canvas)}
@media (pointer:coarse){
  .go{width:2.75rem;height:2.75rem}
  .field{grid-template-columns:1fr;min-height:2.75rem}
}
@media (prefers-reduced-motion:reduce){.go{transition:none}}`;

function markSvg(): string {
  return `<svg class="mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2" width="8" height="14" fill="#171717"/><rect x="10" y="4" width="6" height="12" fill="#0d7268"/></svg>`;
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${SHELL_CSS}</style></head><body><main class="wrap"><p class="brand">${markSvg()} OpenSesame</p>${body}</main></body></html>`;
}

export function renderAgentAuthClaimPage(opts: {
  claimAttemptToken?: string;
  error?: string;
  done?: boolean;
  scopes?: readonly string[];
  principalId?: string;
  registrationId?: string;
}): string {
  if (opts.done) {
    return shell(
      "Claim complete",
      `<h1>The agent may now act</h1><p class="lede">You can close this window. The agent will pick up the new credential on its next poll.</p>`,
    );
  }
  const token = escapeHtml(opts.claimAttemptToken ?? "");
  const errorText = opts.error ? claimErrorCopy(opts.error) : "";
  const error = errorText
    ? `<p class="alert" id="claim-error" role="alert">${escapeHtml(errorText)}</p>`
    : "";
  const describedBy = ["claim-hint", errorText ? "claim-error" : ""]
    .filter(Boolean)
    .join(" ");
  const invalid = errorText ? ` aria-invalid="true"` : "";
  const records: string[] = [];
  if (opts.principalId) {
    records.push(`<dt>Signed in</dt><dd>${escapeHtml(opts.principalId)}</dd>`);
  }
  if (opts.registrationId) {
    records.push(
      `<dt>Registration</dt><dd>${escapeHtml(opts.registrationId)}</dd>`,
    );
  }
  if (opts.scopes && opts.scopes.length > 0) {
    records.push(
      `<dt>Scopes</dt><dd>${escapeHtml(opts.scopes.join(" · "))}</dd>`,
    );
  }
  const record =
    records.length > 0 ? `<dl class="record">${records.join("")}</dl>` : "";
  return shell(
    "Claim this agent",
    `<h1>Claim this agent</h1>
<p class="lede">Enter the 6-digit code the agent printed. That binds this signed-in session to the agent. Accounts are not merged by email.</p>
${record}
${error}
<form method="post" action="/agent/identity/claim/complete">
<input type="hidden" name="claim_attempt_token" value="${token}">
<div class="field"><label for="user_code">Code</label><input id="user_code" name="user_code" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="done" spellcheck="false" required pattern="[0-9]{6}" maxlength="6" aria-describedby="${describedBy}"${invalid}></div>
<p class="hint" id="claim-hint">Six digits. Not a password.</p>
<div class="go-row"><button class="go" type="submit" aria-label="Confirm this agent" title="Confirm this agent"></button><span class="go-verb" aria-hidden="true">Confirm this agent</span></div>
</form>
<p class="mute">If this was not you, close the window. The agent will not gain these scopes.</p>`,
  );
}

export function renderAgentAuthLoginPage(opts: {
  returnTo: string;
  publicUrl: string;
}): string {
  const returnTo = escapeHtml(safeAgentAuthReturnTo(opts.returnTo));
  const issuer = escapeHtml(opts.publicUrl);
  return shell(
    "Sign in to claim",
    `<h1>Sign in to continue</h1>
<p class="lede">Claiming an agent needs an OpenSesame session. Sign in, then we bring you back to enter the agent&rsquo;s code.</p>
<form method="post" action="/login/start">
<input type="hidden" name="return_to" value="${returnTo}">
<div class="go-row"><button class="go" type="submit" aria-label="Sign in" title="Sign in"></button><span class="go-verb" aria-hidden="true">Sign in</span></div>
</form>
<p class="mute">Issuer ${issuer}</p>
<p class="mute">After sign-in you return to <a class="inline" href="${returnTo}">the claim page</a>.</p>`,
  );
}
