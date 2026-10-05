import {
  clearSignInService,
  normalizeSignInService,
  readSignInService,
  writeSignInService,
} from "@opensesame/app-core/lib/identity-service.js";
import { listSecondSteps } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { type FormEvent, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconConnection } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import type { KeyView } from "./key-kinds.js";
import type { Run } from "./run.js";

type CardProps = { busy: boolean; run: Run; onDone: () => void };

/**
 * The card for the sign-in service: the address email and text codes are
 * requested from. The one setting behind those two rows, so the row that needs
 * it opens this rather than pointing at another page (ADR 0091).
 */
export function ServiceCeremony({
  view,
  ...card
}: CardProps & { view: KeyView }) {
  return view === "remove" ? (
    <ForgetCard {...card} />
  ) : (
    <AddressCard view={view} {...card} />
  );
}

function ForgetCard({ busy, run, onDone }: CardProps) {
  const { header } = useVault();
  // An enrolled email or text code is asked at unlock, and only this service
  // can send it: forgetting the address under one could shut the vault.
  const inUse = listSecondSteps(header).some(
    (step) => step === "email" || step === "sms",
  );
  return (
    <CeremonyShell
      name={readSignInService()}
      facts={[
        inUse
          ? {
              key: "Kept",
              value: "an email or text code still needs it; remove those first",
            }
          : { key: "After", value: "email and text codes are not offered" },
        { key: "Vault", value: "untouched; your keys keep working" },
      ]}
      primary={{
        label: "Forget service",
        tone: "danger",
        busy,
        disabled: inUse,
        onClick: () =>
          void run(async () => {
            clearSignInService();
            onDone();
          }, "Sign-in service forgotten."),
      }}
      secondary={{ label: "Keep it", onClick: onDone }}
    />
  );
}

function AddressCard({
  view,
  busy,
  run,
  onDone,
}: CardProps & { view: KeyView }) {
  const [address, setAddress] = useState(
    view === "change" ? readSignInService() : "",
  );
  const normalized = normalizeSignInService(address);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!normalized) return;
    void run(async () => {
      writeSignInService(normalized);
      onDone();
    }, "Sign-in service saved. Email and text codes can be added now.");
  };

  return (
    <form onSubmit={submit}>
      <CeremonyShell
        ok={normalized !== null}
        name={normalized ?? "Address of your sign-in service"}
        facts={[
          { key: "Sends", value: "email and text codes" },
          { key: "Kept", value: "on this device only" },
        ]}
        primary={{
          label: view === "change" ? "Save address" : "Use this service",
          busy,
          disabled: normalized === null,
          submit: true,
          onClick: () => undefined,
        }}
      >
        <FieldShell
          label="Sign-in service"
          type="url"
          mono
          lead={<IconConnection size={17} />}
          placeholder="https://login.example.com"
          autoComplete="url"
          value={address}
          onValueChange={setAddress}
          hint={
            address.trim().length > 0 && normalized === null
              ? "An https address, or http on this machine."
              : undefined
          }
        />
      </CeremonyShell>
    </form>
  );
}
