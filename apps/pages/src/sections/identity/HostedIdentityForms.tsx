import {
  createOAuthClient,
  createOrganization,
} from "@opensesame/app-core/lib/directory.js";
import { ORG_SLUG_RE } from "@opensesame/app-core/lib/orgs.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { identityErrorText } from "@opensesame/app-core/sections/identity-section-model.js";
import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useState,
} from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconPlus, IconX } from "../../components/Icons.js";

export function CreateClientForm({
  online,
  onCreated,
  onCancel,
  onFlash,
}: {
  online: boolean;
  onCreated: (id: string) => void;
  onCancel: () => void;
  onFlash: (flash: Flash) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [sectorIdentifier, setSectorIdentifier] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const uris = redirectUris
      .split("\n")
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);
    if (!displayName.trim() || uris.length === 0 || !sectorIdentifier.trim()) {
      onFlash({
        tone: "err",
        text: "A display name, at least one redirect URI, and a sector identifier are all required.",
      });
      return;
    }
    setBusy(true);
    try {
      const created = await createOAuthClient({
        displayName: displayName.trim(),
        redirectUris: uris,
        sectorIdentifier: sectorIdentifier.trim(),
      });
      onFlash({
        tone: "ok",
        text: `${created.displayName} registered as ${created.id}.`,
      });
      setDisplayName("");
      setRedirectUris("");
      setSectorIdentifier("");
      onCreated(created.id);
    } catch (caught) {
      onFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={(event) => void submit(event)}>
        <ClientFields
          busy={busy}
          displayName={displayName}
          setDisplayName={setDisplayName}
          redirectUris={redirectUris}
          setRedirectUris={setRedirectUris}
          sectorIdentifier={sectorIdentifier}
          setSectorIdentifier={setSectorIdentifier}
        />
        <div className="actions actions--end">
          <FormCommit
            label={busy ? "Registering…" : "Register client"}
            disabled={busy || !online}
            busy={busy}
          >
            <IconKey label="Cancel" disabled={busy} onClick={onCancel}>
              <IconX size={16} />
            </IconKey>
          </FormCommit>
        </div>
      </form>
    </>
  );
}

export function CreateOrgForm({
  online,
  onCreated,
  onCancel,
}: {
  online: boolean;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [ssoIssuer, setSsoIssuer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    const normalized = slug.trim().toLowerCase();
    // The same shape the server enforces, checked here so a bad slug never
    // leaves the device.
    if (!ORG_SLUG_RE.test(normalized)) {
      setError(
        "Use a slug like acme-corp — lowercase letters, numbers, and dashes.",
      );
      return;
    }
    if (!displayName.trim()) {
      setError("Give the organization a display name.");
      return;
    }
    setBusy(true);
    try {
      const org = await createOrganization({
        slug: normalized,
        displayName: displayName.trim(),
        ...(ssoIssuer.trim() ? { ssoIssuer: ssoIssuer.trim() } : undefined),
      });
      setCreated(`${org.displayName} was created — you are its owner.`);
      setSlug("");
      setDisplayName("");
      setSsoIssuer("");
      onCreated(org.id);
    } catch (caught) {
      setError(identityErrorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={(event) => void submit(event)}>
        <OrgFields
          busy={busy}
          slug={slug}
          setSlug={setSlug}
          displayName={displayName}
          setDisplayName={setDisplayName}
          ssoIssuer={ssoIssuer}
          setSsoIssuer={setSsoIssuer}
        />
        <FailureNotice
          id="identity:create-organization"
          title="Organization"
          message={error}
        />
        {created ? (
          <output className="note note--ok">
            <IconCheck /> {created}
          </output>
        ) : null}

        <div className="actions actions--end">
          <FormCommit
            label={busy ? "Creating…" : "Create organization"}
            disabled={busy || !online}
            busy={busy}
            icon={<IconPlus size={18} />}
          >
            <IconKey label="Cancel" disabled={busy} onClick={onCancel}>
              <IconX size={16} />
            </IconKey>
          </FormCommit>
        </div>
      </form>
    </>
  );
}

function ClientFields({
  displayName,
  redirectUris,
  sectorIdentifier,
  setDisplayName,
  setRedirectUris,
  setSectorIdentifier,
  busy,
}: {
  displayName: string;
  redirectUris: string;
  sectorIdentifier: string;
  setDisplayName: Dispatch<SetStateAction<string>>;
  setRedirectUris: Dispatch<SetStateAction<string>>;
  setSectorIdentifier: Dispatch<SetStateAction<string>>;
  busy: boolean;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="identity-client-name">
          Display name
        </label>
        <input
          id="identity-client-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Release pipeline"
          maxLength={128}
          disabled={busy}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-client-uris">
          Redirect URIs — one per line
        </label>
        <textarea
          id="identity-client-uris"
          value={redirectUris}
          onChange={(event) => setRedirectUris(event.target.value)}
          placeholder="https://ci.example.com/callback"
          rows={3}
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-client-sector">
          Sector identifier
        </label>
        <input
          id="identity-client-sector"
          value={sectorIdentifier}
          onChange={(event) => setSectorIdentifier(event.target.value)}
          placeholder="https://ci.example.com"
          title="An https URL naming the sector pairwise subjects are computed for"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>
    </>
  );
}

function OrgFields({
  slug,
  displayName,
  ssoIssuer,
  setSlug,
  setDisplayName,
  setSsoIssuer,
  busy,
}: {
  slug: string;
  displayName: string;
  ssoIssuer: string;
  setSlug: Dispatch<SetStateAction<string>>;
  setDisplayName: Dispatch<SetStateAction<string>>;
  setSsoIssuer: Dispatch<SetStateAction<string>>;
  busy: boolean;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="identity-org-slug">
          Slug
        </label>
        <input
          id="identity-org-slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="acme-corp"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-org-name">
          Display name
        </label>
        <input
          id="identity-org-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Acme Corp"
          maxLength={128}
          disabled={busy}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-org-sso">
          SSO issuer (optional)
        </label>
        <input
          id="identity-org-sso"
          value={ssoIssuer}
          onChange={(event) => setSsoIssuer(event.target.value)}
          placeholder="https://login.acme.com"
          title="The OIDC issuer this organization locks sign-ins to"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>
    </>
  );
}
