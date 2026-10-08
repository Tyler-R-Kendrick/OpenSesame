/**
 * Create an organization or user vault address and list the ones an owner
 * already published (ADR 0181). The relay URL is what the person types here.
 * It is not `settings.hostApi`.
 */

import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  type OrgVaultRecord,
  type RelayOwnerKind,
  createOrgVault,
  listOrgVaults,
} from "@opensesame/app-core/lib/vault-relay/client.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";

const NOTICE_ID = "sharing.relay.directory";

/** Tests inject a fetch. The product uses the relay client's own road out. */
export const orgVaultDirectorySeams: { fetch?: typeof fetch } = {};

function notice(body: string): void {
  setStatusNotice({
    id: NOTICE_ID,
    tone: "err",
    title: "Organization vaults",
    body,
  });
}

function refused(status: number): string {
  if (status === 409) return "That address is already published.";
  if (status === 400) return "That address was refused.";
  return "The relay did not answer.";
}

export function OrgVaultDirectoryPanel() {
  const [relay, setRelay] = useState("");
  const [principal, setPrincipal] = useState("");
  const [ownerKind, setOwnerKind] = useState<RelayOwnerKind>("organization");
  const [owner, setOwner] = useState("");
  const [slug, setSlug] = useState("");
  const [vaults, setVaults] = useState<readonly OrgVaultRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const list = async () => {
    dismissNotice(NOTICE_ID);
    if (owner.trim().length === 0 || relay.trim().length === 0) {
      notice("Name the relay and the owner to list.");
      return;
    }
    setBusy(true);
    try {
      const next = await listOrgVaults({
        baseUrl: relay.trim(),
        owner: owner.trim(),
        principal: principal.trim() || undefined,
        fetch: orgVaultDirectorySeams.fetch,
      });
      setVaults(next);
    } catch (error) {
      const status =
        error instanceof Error && "status" in error ? Number(error.status) : 0;
      notice(refused(status));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    dismissNotice(NOTICE_ID);
    if (
      relay.trim().length === 0 ||
      principal.trim().length === 0 ||
      owner.trim().length === 0 ||
      slug.trim().length === 0
    ) {
      notice("Name the relay, the principal, the owner, and the slug.");
      return;
    }
    setBusy(true);
    try {
      await createOrgVault({
        baseUrl: relay.trim(),
        owner: owner.trim(),
        slug: slug.trim(),
        ownerKind,
        principal: principal.trim(),
        fetch: orgVaultDirectorySeams.fetch,
      });
      setSlug("");
      await list();
    } catch (error) {
      const status =
        error instanceof Error && "status" in error ? Number(error.status) : 0;
      notice(refused(status));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="org-vault-directory" aria-label="Organization vaults">
      <div className="field">
        <label htmlFor="org-vault-relay">Relay URL</label>
        <input
          id="org-vault-relay"
          value={relay}
          autoComplete="off"
          onChange={(event) => setRelay(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="org-vault-principal">Principal</label>
        <input
          id="org-vault-principal"
          value={principal}
          autoComplete="off"
          onChange={(event) => setPrincipal(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="org-vault-kind">Owner kind</label>
        <select
          id="org-vault-kind"
          value={ownerKind}
          onChange={(event) =>
            setOwnerKind(
              event.target.value === "user" ? "user" : "organization",
            )
          }
        >
          <option value="organization">Organization</option>
          <option value="user">User</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="org-vault-owner">Owner</label>
        <input
          id="org-vault-owner"
          value={owner}
          autoComplete="off"
          onChange={(event) => setOwner(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="org-vault-slug">Slug</label>
        <input
          id="org-vault-slug"
          value={slug}
          autoComplete="off"
          onChange={(event) => setSlug(event.target.value)}
        />
      </div>
      <div className="field-inline">
        <IconKey
          label="Create vault"
          disabled={busy}
          onClick={() => void create()}
        >
          <IconPlus size={16} />
        </IconKey>
        <IconKey
          label="List vaults"
          disabled={busy}
          onClick={() => void list()}
        >
          <IconRefresh size={16} />
        </IconKey>
      </div>
      <ul aria-label="Vaults for this owner">
        {vaults.map((vault) => (
          <li key={`${vault.ownerKind}/${vault.owner}/${vault.slug}`}>
            {vault.owner}/{vault.slug}
          </li>
        ))}
      </ul>
    </section>
  );
}
