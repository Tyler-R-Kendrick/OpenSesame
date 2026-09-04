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

/** Pages unlock/sign-in tokens and layout, inlined for the Identity CSP. */
const SHELL_CSS = `:root{color-scheme:light;--canvas:#fafafa;--surface:#fff;--ink:#171717;--ink-2:#5c5c5c;--ink-3:#6f6f6f;--line:#e7e7e7;--accent:#0d7268;--err:#b32424;--radius:2px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,"Noto Sans",sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;min-height:100dvh;background:var(--canvas);color:var(--ink);font-family:var(--font);font-size:0.9375rem;line-height:1.5}
.unlock{min-height:100dvh;display:grid;place-items:center;padding:2rem 1.25rem}
.unlock__card{position:relative;width:min(100%,27rem);min-width:0;display:grid;gap:1rem;padding:1.85rem 0 1.6rem}
.unlock__brand{display:grid;justify-items:start;gap:0.6rem}
.wordmark{display:inline-flex;align-items:center;gap:0.4rem;margin:0;font-family:var(--mono);font-size:0.8125rem;font-weight:600;color:var(--ink-2);letter-spacing:0.02em}
.unlock__brand h1{margin:0;font-size:1.4rem;line-height:1.2;font-weight:600}
.unlock__brand p{margin:0;color:var(--ink-2);font-size:0.875rem;max-width:34ch;text-wrap:balance}
.signin{display:grid;gap:0.85rem}
.signin__bar{display:flex;justify-content:center;align-items:center;gap:0.5rem}
.signin__social{appearance:none;width:2.75rem;min-height:2.6rem;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none;border:1px solid #dadce0;border-radius:var(--radius);background:#fff;color:#1f1f1f;cursor:pointer}
.signin__social:hover{background:#f7f8f8}
.signin__social:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.signin__social svg{display:block}
.signin__provider-note{font-size:0.75rem;color:var(--ink-3);text-align:center;margin:0}
.signin__more{display:flex;justify-content:center}
.signin__more button{appearance:none;border:0;background:none;color:var(--accent);font:inherit;font-size:0.875rem;font-weight:600;text-decoration:underline;text-underline-offset:0.18em;cursor:pointer;padding:0.25rem}
.record{border-top:1px solid var(--line);padding:0.65rem 0 0;margin:0;display:grid;gap:0.45rem}
.record div{display:grid;gap:0.1rem}
.record dt{font-family:var(--mono);font-size:0.75rem;font-weight:600;color:var(--ink-2)}
.record dd{margin:0;font-family:var(--mono);font-size:0.8125rem}
.field{display:grid;gap:0.3rem}
.field label{font-family:var(--mono);font-size:0.75rem;font-weight:600}
.field input{width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;color:var(--ink);font-family:var(--mono);font-size:1.0625rem;letter-spacing:0.18em;padding:0.45rem 0;caret-color:var(--ink)}
.field input:focus{outline:none;border-bottom-width:2px;border-bottom-color:var(--ink);padding-bottom:calc(0.45rem - 1px)}
.hint{margin:0;font-family:var(--mono);font-size:0.75rem;color:var(--ink-2)}
.alert{margin:0;color:var(--err);font-size:0.875rem}
.go-row{display:flex;align-items:center;gap:0.6rem}
.go{appearance:none;display:grid;place-items:center;width:2.5rem;height:2.5rem;flex:none;border:0;border-radius:var(--radius);background:var(--ink);color:var(--canvas);cursor:pointer}
.go:hover{background:color-mix(in srgb,var(--ink) 82%,var(--canvas))}
.go:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.go-verb{font-family:var(--mono);font-size:0.8125rem;color:var(--ink-2)}
.mute{margin:0;font-size:0.75rem;color:var(--ink-3)}
a.inline{color:var(--accent);font-weight:600;text-underline-offset:0.18em}
::selection{background:var(--ink);color:var(--canvas)}
@media (pointer:coarse){.go,.signin__social{width:2.75rem;height:2.75rem;min-height:2.75rem}}
@media (prefers-reduced-motion:reduce){.go,.signin__social{transition:none}}`;

function markSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="12" height="17" fill="currentColor"/><rect x="18.2" y="3.5" width="2.3" height="17" fill="#0d7268"/></svg>`;
}

function googleMark(): string {
  return `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/><path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/></svg>`;
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${SHELL_CSS}</style></head><body><div class="unlock"><div class="unlock__card">${body}</div></div></body></html>`;
}

function brand(heading: string, lede: string): string {
  return `<div class="unlock__brand"><p class="wordmark">${markSvg()} opensesame</p><h1>${escapeHtml(heading)}</h1><p>${lede}</p></div>`;
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
      `${brand("The agent may now act", "You can close this window. The agent will pick up the new credential on its next poll.")}`,
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
  const rows: string[] = [];
  if (opts.principalId) {
    rows.push(
      `<div><dt>Signed in</dt><dd>${escapeHtml(opts.principalId)}</dd></div>`,
    );
  }
  if (opts.registrationId) {
    rows.push(
      `<div><dt>Registration</dt><dd>${escapeHtml(opts.registrationId)}</dd></div>`,
    );
  }
  if (opts.scopes && opts.scopes.length > 0) {
    rows.push(
      `<div><dt>Scopes</dt><dd>${escapeHtml(opts.scopes.join(" · "))}</dd></div>`,
    );
  }
  const record =
    rows.length > 0 ? `<dl class="record">${rows.join("")}</dl>` : "";
  return shell(
    "Claim this agent",
    `${brand("Claim this agent", "Enter the 6-digit code the agent printed. That binds this signed-in session to the agent.")}
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
    "Sign in",
    `${brand("Sign in", "Claiming an agent needs an OpenSesame session. Sign in, then we bring you back to enter the agent&rsquo;s code.")}
<div class="signin">
<form class="signin__bar" method="post" action="/login/start">
<input type="hidden" name="return_to" value="${returnTo}">
<input type="hidden" name="provider" value="google">
<button class="signin__social" type="submit" data-choice="google" aria-label="Google" title="Google">${googleMark()}</button>
</form>
<p class="signin__provider-note">Google via this Identity API</p>
<form class="signin__more" method="post" action="/login/start">
<input type="hidden" name="return_to" value="${returnTo}">
<button type="submit">More sign-in options</button>
</form>
</div>
<p class="mute">After sign-in you return to <a class="inline" href="${returnTo}">the claim page</a>. ${issuer}</p>`,
  );
}
