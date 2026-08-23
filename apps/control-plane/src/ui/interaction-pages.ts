import { escapeHtml } from "../middleware/security-headers.js";

export interface LoginPageModel {
  uid: string;
  csrfToken: string;
  /** POST target for both login forms (`/interaction/<uid>/login`). */
  loginAction: string;
  /** Set when the browser already holds an authenticated session. */
  principalId?: string;
  publicUrl: string;
  /**
   * Federated sign-in offers (ADR 0033 §4). Absent when no upstream is
   * allowlisted, in which case the page falls back to session-only actions.
   */
  federated?: {
    /** POST target (`/interaction/<uid>/federated/start`). */
    startAction: string;
    upstreams: { issuer: string; label: string }[];
    /** Issuer the client hinted at; rendered first and as the primary action. */
    preferredIssuer?: string;
  };
}

export interface ConsentPageModel {
  uid: string;
  csrfToken: string;
  /** POST targets (`/interaction/<uid>/confirm` and `/abort`). */
  confirmAction: string;
  abortAction: string;
  /** Canonical origin string shown to the user. */
  origin: string;
  /** True when an origin_profile client is auto-admitted and unclaimed (ADR 0050 F6). */
  showAutoAdmitted: boolean;
  scopes: string[];
  clientDisplayName?: string;
}

const sharedStyles = `
  :root {
    color-scheme: light dark;
    --bg: #0f1419;
    --fg: #e7ecf3;
    --muted: #9aa7b5;
    --accent: #3d8bfd;
    --danger: #f07178;
    --surface: #1c2430;
    --border: #2a3441;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --fg: #1f2328;
      --muted: #59636e;
      --surface: #ffffff;
      --border: #d1d9e0;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.5;
  }
  main {
    max-width: 36rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 3rem;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  .lede { color: var(--muted); margin: 0 0 1.5rem; }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }
  .origin {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
    font-size: 0.95rem;
  }
  .badge {
    display: inline-block;
    margin-top: 0.75rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--fg);
    font-size: 0.85rem;
  }
  ul.scopes { margin: 0.75rem 0 0; padding-left: 1.25rem; }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 1.25rem;
  }
  button, .btn {
    appearance: none;
    border: 0;
    border-radius: 8px;
    padding: 0.65rem 1rem;
    font: inherit;
    cursor: pointer;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  button:focus-visible, .btn:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 2px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
`;

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>${sharedStyles}</style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

/**
 * Sign-in step. The account never travels in a form field: "Continue"
 * re-uses the session the cookie middleware already authenticated, and
 * "Start a session" mints a fresh provisional principal server-side.
 */
export function renderLoginPage(model: LoginPageModel): string {
  const csrf = escapeHtml(model.csrfToken);
  const action = escapeHtml(model.loginAction);
  // Exactly one primary action per page. When a provider is on offer it holds
  // that slot (ADR 0033 §4: identity before an anonymous principal), so the
  // session action steps down to secondary rather than competing with it.
  const hasFederated = (model.federated?.upstreams.length ?? 0) > 0;
  const sessionButtonClass = hasFederated ? "btn" : "btn btn-primary";
  const continueBlock = model.principalId
    ? `<p>Signed in as <code>${escapeHtml(model.principalId)}</code>.</p>
       <form method="post" action="${action}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <input type="hidden" name="action" value="continue"/>
         <button type="submit" class="${sessionButtonClass}">Continue</button>
       </form>`
    : `<p>No session yet. Start a session to authorize this application.</p>
       <form method="post" action="${action}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <input type="hidden" name="action" value="start"/>
         <button type="submit" class="${sessionButtonClass}">Start a session</button>
       </form>`;

  return pageShell(
    "Sign in — OpenSesame",
    `<h1>Sign in</h1>
     <p class="lede">Authenticate to continue authorization at ${escapeHtml(model.publicUrl)}.</p>
     <div class="panel">${renderFederatedBlock(model)}${continueBlock}</div>`,
  );
}

/**
 * Federated offers, above the session actions so identity comes before a
 * bare anonymous session (ADR 0033 §4). One plain form per upstream: the
 * interaction pages ship under a CSP with no inline script, so there is
 * nothing to auto-submit and the issuer travels as a hidden field that the
 * start route re-checks against the allowlist.
 */
function renderFederatedBlock(model: LoginPageModel): string {
  const federated = model.federated;
  if (!federated || federated.upstreams.length === 0) return "";

  const csrf = escapeHtml(model.csrfToken);
  const startAction = escapeHtml(federated.startAction);
  const ordered = [...federated.upstreams].sort((a, b) => {
    const preferred = federated.preferredIssuer;
    if (!preferred) return 0;
    return a.issuer === preferred ? -1 : b.issuer === preferred ? 1 : 0;
  });

  const forms = ordered
    .map((upstream, index) => {
      const primary =
        federated.preferredIssuer !== undefined
          ? upstream.issuer === federated.preferredIssuer
          : index === 0;
      return `<form method="post" action="${startAction}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <input type="hidden" name="issuer" value="${escapeHtml(upstream.issuer)}"/>
         <button type="submit" class="${primary ? "btn btn-primary" : "btn"}">Sign in with ${escapeHtml(upstream.label)}</button>
       </form>`;
    })
    .join("\n");

  return `${forms}
     <p class="lede">or continue without a provider</p>`;
}

/**
 * Consent step (ADR 0034 §3, ADR 0050 F6): shows the exact canonical origin
 * and badges unclaimed auto-admitted origin clients.
 */
export function renderConsentPage(model: ConsentPageModel): string {
  const csrf = escapeHtml(model.csrfToken);
  const confirmAction = escapeHtml(model.confirmAction);
  const abortAction = escapeHtml(model.abortAction);
  const origin = escapeHtml(model.origin);
  const scopes =
    model.scopes.length > 0
      ? `<ul class="scopes" aria-label="Requested scopes">${model.scopes
          .map((s) => `<li><code>${escapeHtml(s)}</code></li>`)
          .join("")}</ul>`
      : "<p>No additional scopes requested.</p>";
  const autoBadge = model.showAutoAdmitted
    ? `<p class="badge" role="status">Automatically admitted application</p>`
    : "";
  const title = model.clientDisplayName
    ? escapeHtml(model.clientDisplayName)
    : "Application";

  return pageShell(
    "Authorize — OpenSesame",
    `<h1>Authorize ${title}</h1>
     <p class="lede">Review what this application is requesting.</p>
     <div class="panel">
       <p>This application runs at:</p>
       <p class="origin" id="app-origin"><code>${origin}</code></p>
       ${autoBadge}
       <h2 class="sr-only">Requested permissions</h2>
       ${scopes}
       <div class="actions">
         <form method="post" action="${confirmAction}">
           <input type="hidden" name="_csrf" value="${csrf}"/>
           <button type="submit" class="btn btn-primary">Continue</button>
         </form>
         <form method="post" action="${abortAction}">
           <input type="hidden" name="_csrf" value="${csrf}"/>
           <button type="submit" class="btn btn-danger">Deny</button>
         </form>
       </div>
     </div>`,
  );
}

/** Collect scope strings from the request and the consent prompt details. */
export function collectConsentScopes(
  paramsScope: string | undefined,
  missingOIDCScope: string[] | undefined,
): string[] {
  const fromParams = (paramsScope ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = missingOIDCScope ?? [];
  return [...new Set([...fromParams, ...missing])].sort();
}
