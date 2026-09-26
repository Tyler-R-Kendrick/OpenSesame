/**
 * The upstream an organization's people sign in through: an OIDC issuer and
 * the client its owner registered there, or a SAML IdP. The client secret is
 * write-only — never seeded, and an empty box leaves the stored one alone
 * (`upstreamPatch`). The redirect URI is the one value the owner copies out
 * to their provider.
 */

import { copyTextBestEffort } from "@opensesame/app-core/lib/configuration/clipboard-copy.js";
import type {
  OrgSignInOrganization,
  UpstreamForm,
} from "@opensesame/app-core/lib/org-signin.js";
import { type FormEvent, type ReactNode, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCopy } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import type { OrgSignInState } from "./use-org-signin.js";

type Field = Exclude<keyof UpstreamForm, "ssoClientSecret">;

const FIELDS: ReadonlyArray<{
  key: Field;
  id: string;
  label: string;
  type: "text" | "url";
  placeholder: string;
}> = [
  {
    key: "ssoIssuer",
    id: "org-sso-issuer",
    label: "OIDC issuer",
    type: "url",
    placeholder: "https://idp.acme.example",
  },
  {
    key: "ssoClientId",
    id: "org-sso-client-id",
    label: "Client ID",
    type: "text",
    placeholder: "Issued by your identity provider",
  },
  {
    key: "samlIssuer",
    id: "org-saml-issuer",
    label: "SAML IdP entity ID",
    type: "text",
    placeholder: "https://idp.acme.example/saml",
  },
  {
    key: "samlMetadataUrl",
    id: "org-saml-metadata",
    label: "SAML metadata URL",
    type: "url",
    placeholder: "https://idp.acme.example/saml/metadata",
  },
];

/** The one value an owner copies out to their provider. */
function RedirectField({
  redirectUri,
  state,
}: {
  redirectUri: string;
  state: OrgSignInState;
}) {
  async function copy() {
    const copied = await copyTextBestEffort(redirectUri, navigator.clipboard);
    state.note({
      where: "upstream",
      tone: copied.ok ? "ok" : "err",
      label: copied.ok ? "Redirect URI copied" : copied.message,
    });
  }
  return (
    <FieldShell
      id="org-redirect-uri"
      label="Redirect URI"
      mono
      readOnly
      value={redirectUri}
      tail={
        <IconKey
          small
          label="Copy the redirect URI"
          onClick={() => void copy()}
        >
          <IconCopy size={16} />
        </IconKey>
      }
    />
  );
}

/** The upstream form: the secret is never seeded, and cleared once sent. */
function UpstreamFields({
  org,
  state,
  online,
}: {
  org: OrgSignInOrganization;
  state: OrgSignInState;
  online: boolean;
}) {
  const [form, setForm] = useState<UpstreamForm>(org.upstream);
  const [stored, setStored] = useState(org.secretStored);
  const set = (key: keyof UpstreamForm) => (next: string) =>
    setForm((current) => ({ ...current, [key]: next }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const sent = form.ssoClientSecret.trim() !== "";
    if (!(await state.saveUpstream(form))) return;
    if (sent) setStored(true);
    setForm((current) => ({ ...current, ssoClientSecret: "" }));
  }

  const field = (key: Field) => {
    const spec = FIELDS.find((entry) => entry.key === key);
    if (!spec) return null;
    return (
      <FieldShell
        id={spec.id}
        label={spec.label}
        type={spec.type}
        mono
        value={form[key]}
        placeholder={spec.placeholder}
        autoComplete="off"
        disabled={state.busy}
        onValueChange={set(key)}
      />
    );
  };

  return (
    <form className="org-signin__form" onSubmit={(e) => void submit(e)}>
      {field("ssoIssuer")}
      {field("ssoClientId")}
      <FieldShell
        id="org-sso-client-secret"
        label="Client secret"
        type="password"
        mono
        value={form.ssoClientSecret}
        placeholder={
          stored ? "Stored — type to replace" : "If your provider issues one"
        }
        autoComplete="new-password"
        disabled={state.busy}
        status={
          stored ? (
            <StatusMark tone="ok" label="A client secret is stored" />
          ) : undefined
        }
        onValueChange={set("ssoClientSecret")}
      />
      {field("samlIssuer")}
      {field("samlMetadataUrl")}
      <FormCommit
        label="Save the sign-in upstream"
        disabled={state.busy || !online}
        busy={state.busy}
      />
    </form>
  );
}

export function UpstreamPanel({
  org,
  state,
  online,
  redirectUri,
  head,
  chooser,
}: {
  org: OrgSignInOrganization;
  state: OrgSignInState;
  online: boolean;
  redirectUri: string;
  /** The panel head's other keys: the organization list's reload. */
  head: ReactNode;
  /** Which organization, when the session has more than one. */
  chooser: ReactNode;
}) {
  const guideRef = useGuideTarget<HTMLElement>("identity.org-signin");
  const mark = state.mark?.where === "upstream" ? state.mark : null;
  return (
    <section
      className="panel"
      aria-label={`Sign-in upstream · ${org.displayName}`}
      ref={guideRef}
    >
      <div className="panel__head">
        <h2>Sign-in upstream</h2>
        <div className="actions">
          {mark ? <StatusMark tone={mark.tone} label={mark.label} /> : null}
          {head}
        </div>
      </div>
      <div className="panel__body">
        {chooser}
        <RedirectField redirectUri={redirectUri} state={state} />
        <UpstreamFields org={org} state={state} online={online} />
      </div>
    </section>
  );
}
