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
  createOrgVault,
  listOrgVaults,
} from "@opensesame/app-core/lib/vault-relay/client.js";
import { useState } from "react";
import {
  type DirectoryDraft,
  OrgVaultDirectoryFields,
} from "./OrgVaultDirectoryFields.js";

const NOTICE_ID = "sharing.relay.directory";

const EMPTY_DRAFT: DirectoryDraft = {
  relay: "",
  principal: "",
  ownerKind: "organization",
  orgRole: "owner",
  owner: "",
  slug: "",
};

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
  if (status === 403) return "A member cannot publish that address.";
  if (status === 400) return "That address was refused.";
  return "The relay did not answer.";
}

function statusOf(error: unknown): number {
  return error instanceof Error && "status" in error ? Number(error.status) : 0;
}

async function listVaults(
  draft: DirectoryDraft,
  setVaults: (vaults: readonly OrgVaultRecord[]) => void,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  dismissNotice(NOTICE_ID);
  if (draft.owner.trim().length === 0 || draft.relay.trim().length === 0) {
    notice("Name the relay and the owner to list.");
    return;
  }
  setBusy(true);
  try {
    const next = await listOrgVaults({
      baseUrl: draft.relay.trim(),
      owner: draft.owner.trim(),
      principal: draft.principal.trim() || undefined,
      orgRole: draft.orgRole,
      fetch: orgVaultDirectorySeams.fetch,
    });
    setVaults(next);
  } catch (error) {
    notice(refused(statusOf(error)));
  } finally {
    setBusy(false);
  }
}

async function createVault(
  draft: DirectoryDraft,
  setDraft: (next: DirectoryDraft) => void,
  setVaults: (vaults: readonly OrgVaultRecord[]) => void,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  dismissNotice(NOTICE_ID);
  if (
    draft.relay.trim().length === 0 ||
    draft.principal.trim().length === 0 ||
    draft.owner.trim().length === 0 ||
    draft.slug.trim().length === 0
  ) {
    notice("Name the relay, the principal, the owner, and the slug.");
    return;
  }
  setBusy(true);
  try {
    await createOrgVault({
      baseUrl: draft.relay.trim(),
      owner: draft.owner.trim(),
      slug: draft.slug.trim(),
      ownerKind: draft.ownerKind,
      principal: draft.principal.trim(),
      orgRole: draft.orgRole,
      fetch: orgVaultDirectorySeams.fetch,
    });
    setDraft({ ...draft, slug: "" });
    await listVaults(draft, setVaults, setBusy);
  } catch (error) {
    notice(refused(statusOf(error)));
  } finally {
    setBusy(false);
  }
}

export function OrgVaultDirectoryPanel() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [vaults, setVaults] = useState<readonly OrgVaultRecord[]>([]);
  const [busy, setBusy] = useState(false);

  return (
    <section id="org-vault-directory" aria-label="Organization vaults">
      <OrgVaultDirectoryFields
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        onCreate={() => void createVault(draft, setDraft, setVaults, setBusy)}
        onList={() => void listVaults(draft, setVaults, setBusy)}
      />
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
