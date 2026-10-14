import type { OrgSignInOrganization } from "@opensesame/app-core/lib/org-signin.js";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCheck,
  IconLogin,
  IconRefresh,
} from "../../../components/Icons.js";
import type { IdentityFieldProps } from "./identity-field-definitions.js";

export type IdentityServiceFieldProps = IdentityFieldProps & {
  organizations: readonly OrgSignInOrganization[];
  onLoadOrganizations: () => void;
  onConnectService: () => void;
  onSignInService: () => void;
};
function OrganizationField({
  draft,
  busy,
  onChange,
  organizations,
  onLoadOrganizations,
}: IdentityServiceFieldProps) {
  const id = useId();
  const hasSelection = organizations.some(
    (entry) => entry.id === draft.organizationId,
  );
  return (
    <div className="field keyed-field">
      <label htmlFor={`${id}-organization`}>Organization</label>
      <select
        id={`${id}-organization`}
        value={draft.organizationId}
        disabled={busy}
        onChange={(event) => {
          const organization = organizations.find(
            (entry) => entry.id === event.target.value,
          );
          onChange("organizationId", event.target.value);
          onChange("organizationSlug", organization?.slug ?? "");
        }}
      >
        <option value="">Choose an organization</option>
        {draft.organizationId && !hasSelection ? (
          <option value={draft.organizationId}>
            {draft.organizationSlug || draft.organizationId}
          </option>
        ) : null}
        {organizations.map((entry) => (
          <option key={entry.id} value={entry.id} disabled={!entry.owner}>
            {entry.displayName}
          </option>
        ))}
      </select>
      <IconKey
        label="Load organizations"
        disabled={busy || !draft.brokerUrl.trim()}
        onClick={onLoadOrganizations}
      >
        <IconRefresh size={17} />
      </IconKey>
    </div>
  );
}
export function IdentityServiceFields(props: IdentityServiceFieldProps) {
  return (
    <fieldset className="cx-block">
      <legend>Sign-in service</legend>
      <FieldShell
        label="Identity service URL"
        value={props.draft.brokerUrl}
        type="url"
        mono
        placeholder="https://identity.example.com"
        disabled={props.busy}
        onValueChange={(value) => props.onChange("brokerUrl", value)}
        tail={
          <>
            <IconKey
              label="Connect sign-in service"
              disabled={props.busy || !props.draft.brokerUrl.trim()}
              onClick={props.onConnectService}
            >
              <IconCheck size={17} />
            </IconKey>
            <IconKey
              label="Sign in to organization service"
              disabled={props.busy || !props.draft.brokerUrl.trim()}
              onClick={props.onSignInService}
            >
              <IconLogin size={17} />
            </IconKey>
          </>
        }
      />
      <OrganizationField {...props} />
    </fieldset>
  );
}
