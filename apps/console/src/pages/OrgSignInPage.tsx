import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { useCallback, useEffect, useState } from "react";

/**
 * Organization sign-in settings (D14).
 *
 * Three things an org owner configures and nobody else can: the upstream their
 * people sign in through (OIDC issuer or SAML), the email domains that route
 * work addresses to this org, and the provisioning token their directory
 * pushes users with.
 *
 * The SCIM token is the sharp one. The server hashes it and hands back the
 * plaintext exactly once, at mint (T27) — so this page shows it once, in the
 * response that created it, and has no way to show it again. Losing it means
 * minting another, which is the intended cost.
 */

const identityApi = (
  import.meta.env.VITE_OPENSESAME_ISSUER ??
  import.meta.env.VITE_IDENTITY_API ??
  "http://127.0.0.1:8788"
).replace(/\/$/, "");

type Organization = {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  ssoIssuer?: string;
  samlIssuer?: string;
  samlMetadataUrl?: string;
};

type EmailDomain = {
  domain: string;
  txtRecord: string;
  verifiedAt: string | null;
};

type ScimToken = {
  id: string;
  createdAt: string;
  revokedAt: string | null;
};

async function identityFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${identityApi}${path}`, {
    ...init,
    headers,
    // The console signs in against this same origin; the session cookie is the
    // credential. No operator token is ever offered from a browser.
    credentials: "include",
  });
}

async function failureOf(res: Response, fallback: string): Promise<string> {
  try {
    const body: BoundaryValue = await res.json();
    if (isJsonObject(body)) {
      if (isString(body.message)) return body.message;
      if (isString(body.error)) return body.error;
    }
  } catch {
    // A body that is not JSON says nothing useful; the status does.
  }
  return `${fallback} (${res.status}).`;
}

export function OrgSignInPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [ssoIssuer, setSsoIssuer] = useState("");
  const [samlIssuer, setSamlIssuer] = useState("");
  const [samlMetadataUrl, setSamlMetadataUrl] = useState("");
  const [domains, setDomains] = useState<EmailDomain[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [tokens, setTokens] = useState<ScimToken[]>([]);
  /** Plaintext, in memory, for this render only — never re-fetchable. */
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = organizations.find((org) => org.id === selectedId);
  const isOwner = selected?.role === "owner";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await identityFetch("/v1/organizations");
        if (!res.ok) {
          if (!cancelled) {
            setError(await failureOf(res, "Could not list your organizations"));
          }
          return;
        }
        const body: { organizations?: BoundaryValue } = overlapCast(
          await res.json(),
        );
        const list: Organization[] = Array.isArray(body.organizations)
          ? overlapCast(body.organizations)
          : [];
        if (cancelled) return;
        setOrganizations(list);
        const first = list[0];
        if (first) setSelectedId(first.id);
      } catch {
        if (!cancelled) {
          setError("Could not reach the Identity API.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadOrgDetail = useCallback(async (organization: Organization) => {
    setSsoIssuer(organization.ssoIssuer ?? "");
    setSamlIssuer(organization.samlIssuer ?? "");
    setSamlMetadataUrl(organization.samlMetadataUrl ?? "");
    setDomains([]);
    setTokens([]);
    setMintedToken(null);
    const [domainRes, tokenRes] = await Promise.all([
      identityFetch(`/v1/organizations/${organization.id}/domains`),
      identityFetch(`/v1/organizations/${organization.id}/scim/tokens`),
    ]);
    if (domainRes.ok) {
      const body: { domains?: BoundaryValue } = overlapCast(
        await domainRes.json(),
      );
      setDomains(Array.isArray(body.domains) ? overlapCast(body.domains) : []);
    }
    if (tokenRes.ok) {
      const body: { tokens?: BoundaryValue } = overlapCast(
        await tokenRes.json(),
      );
      setTokens(Array.isArray(body.tokens) ? overlapCast(body.tokens) : []);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    void loadOrgDetail(selected);
  }, [selected, loadOrgDetail]);

  async function run(
    label: string,
    action: () => Promise<string | null>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const message = await action();
      if (message) setStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }

  function saveUpstream(): void {
    if (!selected) return;
    void run("Saving organization sign-in", async () => {
      const res = await identityFetch(`/v1/organizations/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ssoIssuer: ssoIssuer.trim() || null,
          samlIssuer: samlIssuer.trim() || null,
          ...(samlMetadataUrl.trim()
            ? { samlMetadataUrl: samlMetadataUrl.trim() }
            : undefined),
        }),
      });
      if (!res.ok) {
        throw new Error(await failureOf(res, "Could not save organization"));
      }
      return "Organization sign-in saved.";
    });
  }

  function addDomain(): void {
    if (!selected) return;
    void run("Claiming the domain", async () => {
      const res = await identityFetch(
        `/v1/organizations/${selected.id}/domains`,
        { method: "POST", body: JSON.stringify({ domain: newDomain.trim() }) },
      );
      if (!res.ok) {
        throw new Error(await failureOf(res, "Could not claim that domain"));
      }
      const claimed: EmailDomain = overlapCast(await res.json());
      setDomains((current) => [
        ...current.filter((entry) => entry.domain !== claimed.domain),
        claimed,
      ]);
      setNewDomain("");
      return `Publish the TXT record for ${claimed.domain}, then verify it.`;
    });
  }

  function verifyDomain(domain: string): void {
    if (!selected) return;
    void run("Verifying the domain", async () => {
      const res = await identityFetch(
        `/v1/organizations/${selected.id}/domains/${encodeURIComponent(domain)}/verify`,
        { method: "POST" },
      );
      if (!res.ok) {
        throw new Error(await failureOf(res, "Could not verify that domain"));
      }
      const verified: EmailDomain = overlapCast(await res.json());
      setDomains((current) =>
        current.map((entry) =>
          entry.domain === verified.domain ? verified : entry,
        ),
      );
      return `${verified.domain} is verified.`;
    });
  }

  function removeDomain(domain: string): void {
    if (!selected) return;
    void run("Releasing the domain", async () => {
      const res = await identityFetch(
        `/v1/organizations/${selected.id}/domains/${encodeURIComponent(domain)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error(await failureOf(res, "Could not release that domain"));
      }
      setDomains((current) =>
        current.filter((entry) => entry.domain !== domain),
      );
      return `${domain} released.`;
    });
  }

  function mintToken(): void {
    if (!selected) return;
    void run("Minting a provisioning token", async () => {
      const res = await identityFetch(
        `/v1/organizations/${selected.id}/scim/tokens`,
        { method: "POST" },
      );
      if (!res.ok) {
        throw new Error(await failureOf(res, "Could not mint a token"));
      }
      const body: { id?: BoundaryValue; token?: BoundaryValue } = overlapCast(
        await res.json(),
      );
      const mintedId = body.id;
      const plaintext = body.token;
      if (!isString(mintedId) || !isString(plaintext)) {
        throw new Error("The Identity API returned an unusable token.");
      }
      setTokens((current) => [
        ...current,
        { id: mintedId, createdAt: new Date().toISOString(), revokedAt: null },
      ]);
      // The only moment this value exists outside the directory that will use
      // it. Nothing stores it here — not sessionStorage, not the URL.
      setMintedToken(plaintext);
      return null;
    });
  }

  function revokeToken(tokenId: string): void {
    if (!selected) return;
    void run("Revoking the token", async () => {
      const res = await identityFetch(
        `/v1/organizations/${selected.id}/scim/tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error(await failureOf(res, "Could not revoke that token"));
      }
      setTokens((current) => current.filter((entry) => entry.id !== tokenId));
      setMintedToken(null);
      return "Provisioning token revoked.";
    });
  }

  return (
    <section className="panel">
      <h1>Organization sign-in</h1>
      <p>
        Configure how your organization's people sign in: the upstream they come
        from, the email domains that route to you, and the directory token that
        provisions them.
      </p>

      {organizations.length === 0 ? (
        <p>
          No organizations on this session. Sign in as an owner to configure
          organization sign-in.
        </p>
      ) : (
        <div className="field">
          <label htmlFor="org-select">Organization</label>
          <select
            id="org-select"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.displayName} ({org.slug})
              </option>
            ))}
          </select>
        </div>
      )}

      {selected && !isOwner ? (
        <p>
          Only an owner of {selected.displayName} can change these settings.
        </p>
      ) : null}

      {selected && isOwner ? (
        <>
          <h2>Upstream</h2>
          <div className="field">
            <label htmlFor="sso-issuer">SSO issuer (OIDC)</label>
            <input
              id="sso-issuer"
              type="url"
              value={ssoIssuer}
              placeholder="https://idp.acme.example"
              onChange={(e) => setSsoIssuer(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="saml-issuer">SAML IdP entity id</label>
            <input
              id="saml-issuer"
              type="text"
              value={samlIssuer}
              placeholder="https://idp.acme.example/saml"
              onChange={(e) => setSamlIssuer(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="saml-metadata">SAML metadata URL</label>
            <input
              id="saml-metadata"
              type="url"
              value={samlMetadataUrl}
              placeholder="https://idp.acme.example/saml/metadata"
              onChange={(e) => setSamlMetadataUrl(e.target.value)}
            />
            <p className="hint">
              With metadata configured, SAML is run natively by the Identity API
              — sign-in surfaces route it server-side instead of redirecting the
              browser to an OIDC issuer.
            </p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => saveUpstream()}
            >
              Save upstream
            </button>
          </div>

          <h2>Email domains</h2>
          <p>
            A verified domain routes <code>you@domain</code> to this
            organization's sign-in. The address itself is used for routing only
            — it is never stored or attached to anyone.
          </p>
          <ul className="status">
            {domains.map((domain) => (
              <li key={domain.domain}>
                <span className="label">{domain.domain}</span>
                <span className="value">
                  {domain.verifiedAt ? (
                    "verified"
                  ) : (
                    <>
                      Publish TXT <code>{domain.txtRecord}</code>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => verifyDomain(domain.domain)}
                >
                  Verify {domain.domain}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeDomain(domain.domain)}
                >
                  Remove {domain.domain}
                </button>
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="new-domain">Add a domain</label>
            <input
              id="new-domain"
              type="text"
              value={newDomain}
              placeholder="acme.example"
              onChange={(e) => setNewDomain(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || newDomain.trim().length === 0}
              onClick={() => addDomain()}
            >
              Claim domain
            </button>
          </div>

          <h2>Directory provisioning (SCIM)</h2>
          <p>
            A provisioning token lets your directory push joiners, movers and
            leavers to <code>/scim/v2</code>. It is shown once, when it is
            minted, and stored only as a hash — if it is lost, revoke it and
            mint another.
          </p>
          {mintedToken ? (
            <output className="ok">
              <span>Copy this now — it is not shown again: </span>
              <code>{mintedToken}</code>
              <button
                type="button"
                onClick={() => setMintedToken(null)}
                disabled={busy}
              >
                I have copied it
              </button>
            </output>
          ) : null}
          <ul className="status">
            {tokens.map((token) => (
              <li key={token.id}>
                <span className="label">{token.id}</span>
                <span className="value">
                  {token.revokedAt ? "revoked" : "active"}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revokeToken(token.id)}
                >
                  Revoke {token.id}
                </button>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => mintToken()}>
              Mint provisioning token
            </button>
          </div>
        </>
      ) : null}

      {status ? <output className="ok">{status}</output> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
