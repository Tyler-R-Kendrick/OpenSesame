/**
 * Identity › Providers: who vouches for the people here, with the same head
 * keys as every other Identity list (register, reload) and the same armed
 * removal on a row.
 */

import {
  beginSignIn,
  upstreamByIssuer,
} from "@opensesame/app-core/lib/federation.js";
import { presetFor } from "@opensesame/app-core/lib/idp-presets.js";
import {
  DEVICE_IDP_ID,
  type IdpRecord,
  listIdpRegistrations,
  removeIdpRegistration,
} from "@opensesame/app-core/lib/idp-registry.js";
import {
  type FederatedProviderSummary,
  brokeredByoUpstream,
  listFederatedProviders,
  providerUpstream,
} from "@opensesame/app-core/lib/providers.js";
import {
  formatTime,
  identityErrorText,
  providerChipLabel,
} from "@opensesame/app-core/sections/identity-section-model.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import {
  IconLogin,
  IconPlus,
  IconShield,
  IconSite,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { byId, useFocusAfter } from "../../lib/use-focus-after.js";

import { brandFor } from "../../screens/unlock/ProviderBrand.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { monogram } from "../../lib/display-monogram.js";

/**
 * The rows to draw: first-class providers are intersected with the live
 * catalog when it answers; BYO rows and the device IdP always show. A read
 * the panel has moved past (a later refresh, or leaving) is dropped, and an
 * unreachable catalog filters nothing — the same list drawn before it
 * answers.
 */
export function useProviderCatalog(providers: IdpRecord[]) {
  const [catalog, setCatalog] = useState<FederatedProviderSummary[] | null>(
    null,
  );
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    listFederatedProviders().then(
      (found) => {
        if (current === generation.current) setCatalog(found);
      },
      () => {
        if (current === generation.current) setCatalog([]);
      },
    );
  }, []);
  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  const rows = useMemo(() => {
    if (!catalog || catalog.length === 0) return providers;
    const listed = new Set(catalog.map((provider) => provider.id));
    return providers.filter(
      (record) =>
        record.kind === "device" ||
        record.kind === "byo" ||
        listed.has(record.id),
    );
  }, [catalog, providers]);
  return { rows, refresh };
}

const REGISTER_KEY_ID = "identity-register-idp";

/**
 * Who vouches for the people here. OpenSesame (this device) is always first
 * (ADR 0118). Additional rows come from the local registry mirror — the only
 * list a browser can hold for upstreams. First-class rows are intersected with
 * the live catalog when it answers; BYO rows are the registry mirror itself.
 */
export function ProvidersPanel({
  online,
  providers,
  onChanged,
  onOpenCeremony,
}: {
  online: boolean;
  providers: IdpRecord[];
  onChanged: (providers: IdpRecord[]) => void;
  onOpenCeremony: () => void;
}) {
  const { rows, refresh } = useProviderCatalog(providers);
  const registerRef = useGuideTarget<HTMLButtonElement>(
    "identity.register-idp",
  );
  const focusAfter = useFocusAfter(false);

  // A removed row takes its focused key with it; focus lands on Register.
  const rowRemoved = (next: IdpRecord[]) => {
    onChanged(next);
    focusAfter(byId(REGISTER_KEY_ID));
  };

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Providers</h2>
        </div>
        <fieldset className="vtree__keys" aria-label="Provider commands">
          <IconKey
            id={REGISTER_KEY_ID}
            label="Register an IdP"
            small
            keyRef={registerRef}
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
      </div>

      <div className="panel__body">
        <ul className="identity-rows">
          {rows.map((record) => (
            <ProviderRow
              key={record.id}
              record={record}
              online={online}
              onChanged={rowRemoved}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ProviderMark({
  device,
  brand,
  presetLabel,
}: {
  device: boolean;
  brand: ReturnType<typeof brandFor>;
  presetLabel: string | null;
}) {
  if (device) return <IconShield size={18} />;
  if (brand) return <brand.Icon size={18} />;
  if (presetLabel) {
    return (
      <span className="identity-row__monogram" aria-hidden="true">
        {monogram(presetLabel)}
      </span>
    );
  }
  return <IconSite size={18} />;
}

/** Start the sign-in leg a registered provider's row offers. */
async function startProviderSignIn(record: IdpRecord): Promise<void> {
  if (record.kind === "byo") {
    await beginSignIn(
      brokeredByoUpstream({ issuer: record.issuer, label: record.label }),
    );
    return;
  }
  const summary: FederatedProviderSummary = {
    id: record.id,
    label: record.label,
    kind: "oidc",
    browserCapable: upstreamByIssuer(record.issuer)?.id === record.id,
  };
  await beginSignIn(providerUpstream(summary), { providerHint: record.id });
}

function ProviderRow({
  record,
  online,
  onChanged,
}: {
  record: IdpRecord;
  online: boolean;
  onChanged: (providers: IdpRecord[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const device = record.kind === "device" || record.id === DEVICE_IDP_ID;
  const brand = record.kind === "first-class" ? brandFor(record.id) : null;
  const preset = record.providerType ? presetFor(record.providerType) : null;
  const chipLabel = providerChipLabel(device, record.kind, preset?.label);

  return (
    <li className="identity-row" id={record.id}>
      <div className="identity-row__main">
        <span className="identity-row__mark">
          <ProviderMark
            device={device}
            brand={brand}
            presetLabel={preset?.label ?? null}
          />
        </span>
        <div className="identity-row__id">
          <h3>{record.label}</h3>
          <code className="identity-ref">{record.issuer}</code>
          {/* The kind is a label, not a status: plain text in the id column,
              never a pill (DESIGN.md § Status is a symbol). */}
          {device ? null : (
            <span className="identity-row__kind">{chipLabel}</span>
          )}
          {record.kind === "byo" ? (
            <span className="identity-row__when">
              registered {formatTime(record.registeredAt)}
            </span>
          ) : null}
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
      {error ? (
        <>
          <StatusMark tone="err" label={error} />
          <span role="alert" className="visually-hidden">
            {error}
          </span>
        </>
      ) : null}
    </li>
  );
}

export function ProviderActions({
  record,
  online,
  confirming,
  setConfirming,
  setError,
  onChanged,
}: {
  record: IdpRecord;
  online: boolean;
  confirming: boolean;
  setConfirming: (confirming: boolean) => void;
  setError: (error: string | null) => void;
  onChanged: (providers: IdpRecord[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await startProviderSignIn(record);
    } catch (caught) {
      setError(identityErrorText(caught));
      setBusy(false);
    }
  }

  // Local mirror only: the server-side registration is disabled by the
  // operator, never deleted from a browser.
  const remove = () => onChanged(removeIdpRegistration(record.id));

  return (
    <div className="actions">
      <IconKey
        label={busy ? "Starting sign-in" : "Sign in"}
        small
        disabled={busy || !online}
        onClick={() => void signIn()}
      >
        <IconLogin size={16} />
      </IconKey>
      <IconKey
        keyRef={removeRef}
        label={
          confirming
            ? "Remove it from this browser; the operator disables the server registration"
            : "Remove"
        }
        small
        armed={confirming}
        onClick={confirming ? remove : () => setConfirming(true)}
      >
        <IconTrash size={16} />
      </IconKey>
      {confirming ? (
        <IconKey
          label="Keep it"
          small
          onClick={() => {
            setConfirming(false);
            removeRef.current?.focus();
          }}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </div>
  );
}
