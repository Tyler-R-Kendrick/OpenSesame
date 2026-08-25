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
   * Federated sign-in offers (ADR 0033 §4, ADR 0055). Absent when no upstream
   * is allowlisted, in which case the page falls back to session-only actions.
   */
  federated?: {
    /** POST target (`/interaction/<uid>/federated/start`). */
    startAction: string;
    /**
     * `provider` is the registry id, posted as a hidden field and preferred by
     * the start route over `issuer`; both are re-validated server-side, so the
     * rendered buttons stay a convenience rather than the fence.
     */
    upstreams: { issuer: string; label: string; provider?: string }[];
    /** Issuer the client hinted at; rendered first and as the primary action. */
    preferredIssuer?: string;
  };
  /**
   * Bring-your-own provider (ADR 0055 / D5): a visitor with no account names
   * their own OIDC issuer. `error` and `issuerValue` re-render a rejected
   * submission with what they typed.
   */
  byo?: {
    /** POST target (`/interaction/<uid>/federated/byo`). */
    startAction: string;
    error?: string;
    issuerValue?: string;
  };
  /**
   * Enterprise sign-in by organization (D6). Two steps under a CSP with no
   * script: the slug form posts to `lookupAction`, which 303s back to
   * `?org=<slug>`, and that re-render carries the tenant's `methods`.
   */
  org?: {
    /** POST target (`/interaction/<uid>/federated/org`). */
    lookupAction: string;
    slug?: string;
    methods?: { issuer: string; label: string; kind: "sso" | "saml" }[];
    error?: string;
  };
  /** Email magic link (C22 / D18): a verified-email admission path. */
  email?: {
    /** POST target (`/interaction/<uid>/federated/email`). */
    requestAction: string;
    sent?: boolean;
    error?: string;
  };
  /**
   * Home-realm discovery (C16 / D12): a work email routes to the organization
   * that verified its domain. The address is a router and nothing else — it is
   * never stored, logged, or attached to a principal.
   */
  realm?: {
    /** POST target (`/interaction/<uid>/federated/realm`). */
    requestAction: string;
    error?: string;
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
  h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
  .field { display: block; margin-bottom: 0.75rem; }
  .field span { display: block; font-size: 0.9rem; color: var(--muted); }
  .field input {
    width: 100%;
    margin-top: 0.25rem;
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  .note { color: var(--muted); font-size: 0.9rem; margin: 0.5rem 0 0; }
  .error { color: var(--danger); font-size: 0.9rem; margin: 0 0 0.75rem; }
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

  // A visitor who arrived through an organization's slug asked a specific
  // question; its answer goes first. Otherwise the shipped providers lead.
  const orgFirst = (model.org?.methods?.length ?? 0) > 0;
  const identityBlocks = orgFirst
    ? [
        renderOrgBlock(model),
        renderFederatedBlock(model),
        renderEmailBlock(model),
        renderByoBlock(model),
      ]
    : [
        renderFederatedBlock(model),
        renderOrgBlock(model),
        renderEmailBlock(model),
        renderByoBlock(model),
      ];

  return pageShell(
    "Sign in — OpenSesame",
    `<h1>Sign in</h1>
     <p class="lede">Authenticate to continue authorization at ${escapeHtml(model.publicUrl)}.</p>
     ${identityBlocks.filter(Boolean).join("\n     ")}
     <div class="panel">
       <p class="lede">or continue without a provider</p>
       ${continueBlock}
     </div>`,
  );
}

/**
 * Federated offers, above the session actions so identity comes before a
 * bare anonymous session (ADR 0033 §4). One plain form per upstream: the
 * interaction pages ship under a CSP with no inline script, so there is
 * nothing to auto-submit and the provider travels as a hidden field that the
 * start route re-resolves through the trust fence.
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
      const provider =
        upstream.provider !== undefined
          ? `\n         <input type="hidden" name="provider" value="${escapeHtml(upstream.provider)}"/>`
          : "";
      return `<form method="post" action="${startAction}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <input type="hidden" name="issuer" value="${escapeHtml(upstream.issuer)}"/>${provider}
         <button type="submit" class="${primary ? "btn btn-primary" : "btn"}">Sign in with ${escapeHtml(upstream.label)}</button>
       </form>`;
    })
    .join("\n");

  return `<div class="panel">${forms}</div>`;
}

function renderError(message: string | undefined): string {
  return message === undefined
    ? ""
    : `<p class="error" role="alert">${escapeHtml(message)}</p>`;
}

/**
 * Enterprise sign-in: the work-email router (D12) and the organization slug
 * form (D6), then — once a slug has resolved — one button per configured
 * method. Both steps are plain POSTs; the CSP forbids the script that would
 * otherwise look a tenant up as the visitor types.
 */
function renderOrgBlock(model: LoginPageModel): string {
  const org = model.org;
  const realm = model.realm;
  if (!org && !realm) return "";

  const csrf = escapeHtml(model.csrfToken);
  const realmForm = realm
    ? `<form method="post" action="${escapeHtml(realm.requestAction)}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <label class="field" for="realm-email"><span>Work email</span>
           <input id="realm-email" name="email" type="email" autocomplete="email" required/>
         </label>
         ${renderError(realm.error)}
         <button type="submit" class="btn">Continue with your work email</button>
       </form>`
    : "";

  if (!org) {
    return `<div class="panel"><h2>Your organization</h2>${realmForm}</div>`;
  }

  const methods = org.methods ?? [];
  const startAction = model.federated?.startAction;
  const methodForms =
    startAction === undefined
      ? ""
      : methods
          .map(
            (
              method,
            ) => `<form method="post" action="${escapeHtml(startAction)}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <input type="hidden" name="issuer" value="${escapeHtml(method.issuer)}"/>
         <button type="submit" class="btn btn-primary">Continue with ${escapeHtml(method.label)}</button>
       </form>`,
          )
          .join("\n");

  const lookupForm = `<form method="post" action="${escapeHtml(org.lookupAction)}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <label class="field" for="org-slug"><span>Organization name</span>
           <input id="org-slug" name="slug" value="${escapeHtml(org.slug ?? "")}" autocomplete="organization" required/>
         </label>
         <button type="submit" class="btn">Continue with your organization</button>
       </form>`;

  return `<div class="panel">
       <h2>Your organization</h2>
       ${renderError(org.error)}
       ${methodForms}
       ${lookupForm}
       ${realmForm}
     </div>`;
}

/** Email magic link (D18): the address is the identifier, deliberately. */
function renderEmailBlock(model: LoginPageModel): string {
  const email = model.email;
  if (!email) return "";
  const csrf = escapeHtml(model.csrfToken);
  const sent = email.sent
    ? `<p class="note" role="status">Check your email for a sign-in link.</p>`
    : "";
  return `<div class="panel">
       <h2>Continue with email</h2>
       ${renderError(email.error)}
       ${sent}
       <form method="post" action="${escapeHtml(email.requestAction)}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <label class="field" for="magic-email"><span>Email address</span>
           <input id="magic-email" name="email" type="email" autocomplete="email" required/>
         </label>
         <button type="submit" class="btn">Email me a sign-in link</button>
       </form>
     </div>`;
}

/**
 * Bring your own provider (D5). The client secret is optional: an issuer that
 * advertises a registration endpoint can be registered dynamically, and a
 * public client needs no secret at all.
 */
function renderByoBlock(model: LoginPageModel): string {
  const byo = model.byo;
  if (!byo) return "";
  const csrf = escapeHtml(model.csrfToken);
  return `<div class="panel">
       <h2>Use your own identity provider</h2>
       ${renderError(byo.error)}
       <form method="post" action="${escapeHtml(byo.startAction)}">
         <input type="hidden" name="_csrf" value="${csrf}"/>
         <label class="field" for="byo-issuer"><span>Issuer URL</span>
           <input id="byo-issuer" name="issuer" type="url" value="${escapeHtml(byo.issuerValue ?? "")}" placeholder="https://id.example.com" required/>
         </label>
         <label class="field" for="byo-client-id"><span>Client ID (optional)</span>
           <input id="byo-client-id" name="client_id" autocomplete="off"/>
         </label>
         <label class="field" for="byo-client-secret"><span>Client secret (optional)</span>
           <input id="byo-client-secret" name="client_secret" type="password" autocomplete="off"/>
         </label>
         <button type="submit" class="btn">Continue with your provider</button>
       </form>
       <p class="note">Leave the client fields empty to let this server register itself with your provider automatically.</p>
     </div>`;
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
