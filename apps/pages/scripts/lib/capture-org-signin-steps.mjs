/**
 * Identity › Organizations' half of the stand-in Identity API (ADR 0140 plan
 * step 12): one organization the session owns, its email domains and its
 * SCIM tokens, answered the way `packages/control-plane` answers them — a
 * claimed domain waits for its TXT record, a verify settles it, a minted
 * token's plaintext is in the mint answer only, and a revoke or a release
 * answers 204.
 */

const ORG = "/v1/organizations/org_evidence";

/** One page's organization: its upstream, domains and tokens. */
export function orgSignInState() {
  return {
    organization: {
      id: "org_evidence",
      slug: "acme",
      displayName: "Acme",
      role: "owner",
      state: "active",
      ssoIssuer: "https://idp.acme.example",
      ssoClientId: "acme-opensesame",
      ssoClientSecretConfigured: true,
    },
    domains: [
      {
        domain: "acme.example",
        txtRecord: "opensesame-domain-verify=tok_evidence_1",
        verifiedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    tokens: [
      {
        id: "sct_evidence_1",
        createdAt: "2026-09-20T00:00:00.000Z",
        revokedAt: null,
      },
    ],
    minted: 0,
  };
}

function bodyOf(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

function answerDomain(state, at, request) {
  if (at === `GET ${ORG}/domains`) return [200, { domains: state.domains }];
  if (at === `POST ${ORG}/domains`) {
    const domain = String(bodyOf(request).domain ?? "");
    const row = {
      domain,
      txtRecord: `opensesame-domain-verify=tok_evidence_${state.domains.length + 1}`,
      verifiedAt: null,
    };
    state.domains = [...state.domains.filter((d) => d.domain !== domain), row];
    return [201, row];
  }
  const verify = at.match(/^POST .*\/domains\/([^/]+)\/verify$/);
  if (verify) {
    const name = decodeURIComponent(verify[1]);
    const row = state.domains.find((d) => d.domain === name);
    if (!row) return [404, { error: "not_found" }];
    const next = { ...row, verifiedAt: "2026-09-26T00:00:00.000Z" };
    state.domains = state.domains.map((d) => (d.domain === name ? next : d));
    return [200, next];
  }
  const release = at.match(/^DELETE .*\/domains\/([^/]+)$/);
  if (release) {
    const name = decodeURIComponent(release[1]);
    state.domains = state.domains.filter((d) => d.domain !== name);
    return [204, null];
  }
  return null;
}

function answerToken(state, at) {
  if (at === `GET ${ORG}/scim/tokens`) return [200, { tokens: state.tokens }];
  if (at === `POST ${ORG}/scim/tokens`) {
    state.minted += 1;
    const id = `sct_evidence_${state.tokens.length + 1}`;
    state.tokens = [
      ...state.tokens,
      { id, createdAt: new Date().toISOString(), revokedAt: null },
    ];
    return [
      201,
      {
        id,
        // A stand-in's value: shaped like a real one, good for nothing.
        token: `sct_evidence_standin_${"0".repeat(20)}${state.minted}`,
        scimBaseUrl: `https://identity.evidence.example${ORG}/scim/v2`,
      },
    ];
  }
  const revoke = at.match(/^DELETE .*\/scim\/tokens\/([^/]+)$/);
  if (revoke) {
    const id = decodeURIComponent(revoke[1]);
    state.tokens = state.tokens.map((t) =>
      t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t,
    );
    return [204, null];
  }
  return null;
}

/** Answer the organization routes; `null` when the call is not one of them. */
export function answerOrgSignIn(state, at, request) {
  if (at === "GET /v1/organizations") {
    return [200, { organizations: [state.organization] }];
  }
  if (at === `PATCH ${ORG}`) {
    // The secret is write-only: kept as "one is stored", never echoed.
    const { ssoClientSecret, ...rest } = bodyOf(request);
    state.organization = {
      ...state.organization,
      ...rest,
      ...(ssoClientSecret ? { ssoClientSecretConfigured: true } : {}),
    };
    return [200, { id: state.organization.id }];
  }
  if (!at.includes(`${ORG}/`)) return null;
  return answerDomain(state, at, request) ?? answerToken(state, at);
}

/** Verbs for Identity › Organizations' sign-in panels. */
export function orgSignInSteps() {
  return {
    /**
     * Print how many of the places this origin keeps text hold `text`:
     * localStorage, sessionStorage, cookies and the address. A minted
     * token's plaintext must be in none of them.
     */
    async storedCopies(page, text) {
      const found = await page.evaluate((needle) => {
        const all = (store) =>
          Array.from({ length: store.length }, (_, i) => {
            const key = store.key(i) ?? "";
            return `${key}=${store.getItem(key) ?? ""}`;
          });
        return [
          ...all(localStorage),
          ...all(sessionStorage),
          document.cookie,
          location.href,
        ].filter((entry) => entry.includes(needle)).length;
      }, text);
      console.log(`  stored copies of ${text}: ${found}`);
    },
  };
}
