import { presetFor } from "@opensesame/app-core/lib/idp-presets.js";
import {
  DEVICE_IDP_ID,
  type IdpRecord,
  listIdpRegistrations,
} from "@opensesame/app-core/lib/idp-registry.js";
import {
  formatTime,
  providerChipLabel,
} from "@opensesame/app-core/sections/identity-section-model.js";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { IdentityFact } from "./IdentityRecordFields.js";
import { ProviderActions, useProviderCatalog } from "./ProvidersPanel.js";
import { identityRecordId } from "./identity-record-selection.js";

export function ProvidersWorkspace({
  online,
  providers,
  onChanged,
  onOpenCeremony,
  editor,
}: {
  online: boolean;
  providers: IdpRecord[];
  onChanged: (next: IdpRecord[]) => void;
  onOpenCeremony: () => void;
  editor?: ReactNode;
}) {
  const { rows, refresh } = useProviderCatalog(providers);
  const { hash } = useLocation();
  const navigate = useNavigate();
  const id = identityRecordId(hash);
  const record = rows.find((row) => row.id === id);
  const guide = useGuideTarget<HTMLButtonElement>("identity.register-idp");
  const listPath = "/identity?view=providers";
  return (
    <RecordWorkspace
      section="Identity"
      title="Providers"
      createGuide="identity.register-idp"
      rootPath="/identity"
      listPath={listPath}
      selectedId={id}
      detailOpen={!!record || !!editor}
      rows={rows.map((row) => ({
        id: row.id,
        label: row.label,
        extension: "provider",
        to: `${listPath}#${encodeURIComponent(row.id)}`,
      }))}
      commands={
        <fieldset className="vtree__keys" aria-label="Provider commands">
          <IconKey
            id="identity-register-idp"
            label="Register an IdP"
            small
            keyRef={guide}
            onClick={onOpenCeremony}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey
            label="Reload providers"
            onReload={() => {
              onChanged(listIdpRegistrations());
              refresh();
            }}
          />
        </fieldset>
      }
    >
      {editor ??
        (record ? (
          <ProviderDetail
            key={record.id}
            record={record}
            online={online}
            onChanged={(next) => {
              onChanged(next);
              navigate(listPath, { replace: true });
            }}
          />
        ) : null)}
    </RecordWorkspace>
  );
}

import { useState } from "react";
function ProviderDetail({
  record,
  online,
  onChanged,
}: {
  record: IdpRecord;
  online: boolean;
  onChanged: (next: IdpRecord[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const device = record.kind === "device" || record.id === DEVICE_IDP_ID;
  return (
    <div className="detail" id={record.id}>
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{record.label}</h1>
          <div className="detail__meta">Provider</div>
        </div>
        {device ? null : (
          <ProviderActions
            record={record}
            online={online}
            confirming={confirming}
            setConfirming={setConfirming}
            setError={setError}
            onChanged={onChanged}
          />
        )}
      </div>
      <section className="detail__group">
        <h2 className="detail__grouphead">Provider</h2>
        <IdentityFact label="Issuer">{record.issuer}</IdentityFact>
        <IdentityFact label="Type">
          {providerChipLabel(
            device,
            record.kind,
            record.providerType
              ? presetFor(record.providerType)?.label
              : undefined,
          )}
        </IdentityFact>
        <IdentityFact label="Registered">
          {formatTime(record.registeredAt)}
        </IdentityFact>
      </section>
      <FailureNotice id="identity:provider" title="Provider" message={error} />
    </div>
  );
}
