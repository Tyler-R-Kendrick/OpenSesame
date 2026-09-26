/**
 * One organization's sign-in settings, as the panels hold them: its email
 * domains, its provisioning tokens, and the one freshly minted token.
 *
 * Every call goes through app-core's `orgSignInClient`; nothing here builds
 * a request. The minted token's plaintext lives in this hook's state and
 * nowhere else — not storage, not a settings file, not the address bar, not
 * a log, not WebMCP — and it is dropped when the person hides it, when a
 * token is revoked, when the vault locks, when the Identity session ends,
 * and when the panels unmount (leaving the tab, or choosing another
 * organization: the panels are keyed by it).
 */

import {
  currentSession,
  subscribeIdentitySession,
} from "@opensesame/app-core/lib/identity.js";
import type {
  EmailDomainRow,
  MintedScimToken,
  OrgSignInClient,
  OrgSignInOrganization,
  ScimTokenRow,
  UpstreamForm,
} from "@opensesame/app-core/lib/org-signin.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useEffect, useState } from "react";
import type { StatusTone } from "../../../components/StatusMark.js";

/** The panel an outcome is marked in. */
export type OrgSignInPanel = "upstream" | "domains" | "tokens";

export type OrgSignInMark = {
  where: OrgSignInPanel;
  tone: StatusTone;
  label: string;
};

const said = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Forget the minted plaintext on lock and on sign-out. */
function useForgetMinted(forget: () => void): void {
  useEffect(() => {
    const offLock = vaultStore.onLock(forget);
    const offSession = subscribeIdentitySession(() => {
      if (currentSession() === null) forget();
    });
    return () => {
      offLock();
      offSession();
    };
  }, [forget]);
}

function upsert(rows: EmailDomainRow[] | null, row: EmailDomainRow) {
  const kept = (rows ?? []).filter((entry) => entry.domain !== row.domain);
  return [...kept, row];
}

export function useOrgSignIn(
  client: OrgSignInClient,
  org: OrgSignInOrganization,
) {
  const [domains, setDomains] = useState<EmailDomainRow[] | null>(null);
  const [tokens, setTokens] = useState<ScimTokenRow[] | null>(null);
  const [minted, setMinted] = useState<MintedScimToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<OrgSignInMark | null>(null);
  const forget = useCallback(() => setMinted(null), []);
  useForgetMinted(forget);

  useEffect(() => {
    let live = true;
    client.listDomains(org).then(
      (rows) => live && setDomains(rows),
      (error: unknown) =>
        live && setMark({ where: "domains", tone: "err", label: said(error) }),
    );
    client.listTokens(org).then(
      (rows) => live && setTokens(rows),
      (error: unknown) =>
        live && setMark({ where: "tokens", tone: "err", label: said(error) }),
    );
    return () => {
      live = false;
    };
  }, [client, org]);

  /** One call at a time; its outcome is marked in the panel it came from. */
  const run = useCallback(
    async (where: OrgSignInPanel, action: () => Promise<string | null>) => {
      setBusy(true);
      setMark(null);
      try {
        const words = await action();
        if (words) setMark({ where, tone: "ok", label: words });
        return true;
      } catch (error) {
        setMark({ where, tone: "err", label: said(error) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return {
    domains,
    tokens,
    minted,
    busy,
    mark,
    note: (next: OrgSignInMark) => setMark(next),
    saveUpstream: (form: UpstreamForm) =>
      run("upstream", () => client.saveUpstream(org, form)),
    claim: (domain: string) =>
      run("domains", async () => {
        const { row, words } = await client.claimDomain(org, domain);
        setDomains((rows) => upsert(rows, row));
        return words;
      }),
    verify: (domain: string) =>
      run("domains", async () => {
        const { row, words } = await client.verifyDomain(org, domain);
        setDomains((rows) => upsert(rows, row));
        return words;
      }),
    release: (domain: string) =>
      run("domains", async () => {
        const words = await client.releaseDomain(org, domain);
        setDomains((rows) => (rows ?? []).filter((r) => r.domain !== domain));
        return words;
      }),
    mint: () =>
      run("tokens", async () => {
        // The one moment the plaintext exists here. It goes to state only;
        // the list gains the id and the date, never the value.
        const next = await client.mintToken(org);
        setMinted(next);
        const row = { id: next.id, createdAt: new Date().toISOString() };
        setTokens((rows) => [...(rows ?? []), { ...row, revoked: false }]);
        return null;
      }),
    revoke: (tokenId: string) =>
      run("tokens", async () => {
        const words = await client.revokeToken(org, tokenId);
        setMinted(null);
        setTokens((rows) =>
          (rows ?? []).map((r) =>
            r.id === tokenId ? { ...r, revoked: true } : r,
          ),
        );
        return words;
      }),
    dismiss: forget,
  };
}

export type OrgSignInState = ReturnType<typeof useOrgSignIn>;
