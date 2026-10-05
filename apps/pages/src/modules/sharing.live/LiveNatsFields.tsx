/**
 * A NATS server's own choices in the Routes Form (ADR 0166): how a session
 * signs in there, and whether the session itself may cross it. A signing key
 * stays in this vault's sealed profile; what a link carries is minted from it
 * per session (`lib/live/nats-credentials.ts`).
 */

import {
  NATS_SESSIONS,
  type NatsSession,
  isAccountKey,
  isAccountSeed,
  isUserJwt,
  isUserSeed,
  sessionOver,
} from "@opensesame/app-core/lib/live/nats-route.js";
import type {
  CarrierSetting,
  LiveTransport,
} from "@opensesame/app-core/lib/live/transport.js";
import { FieldShell } from "../../components/FieldShell.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { Change } from "./live-route-parts.js";
import { withCarrierSession } from "./live-transport-edits.js";

export const NATS_SIGN_INS = ["none", "mint", "creds"] as const;
export type NatsSignIn = (typeof NATS_SIGN_INS)[number];

export type NatsDraft = Readonly<{
  signIn: NatsSignIn;
  account: string;
  signingKey: string;
  jwt: string;
  seed: string;
  session: NatsSession;
}>;

export const EMPTY_NATS_DRAFT: NatsDraft = {
  signIn: "none",
  account: "",
  signingKey: "",
  jwt: "",
  seed: "",
  session: "fallback",
};

const SIGN_IN_LABELS = {
  none: "None",
  mint: "Per session",
  creds: "User JWT",
} satisfies Record<NatsSignIn, string>;

export const SESSION_LABELS = {
  fallback: "If direct fails",
  always: "Always",
  off: "Codes only",
} satisfies Record<NatsSession, string>;

/** Whether the draft's sign-in is complete and well formed. */
export function natsDraftReady(draft: NatsDraft): boolean {
  if (draft.signIn === "mint")
    return (
      isAccountKey(draft.account.trim()) && isAccountSeed(draft.signingKey)
    );
  if (draft.signIn === "creds")
    return isUserJwt(draft.jwt.trim()) && isUserSeed(draft.seed.trim());
  return true;
}

/** What the draft adds to a NATS carrier's address. */
export function natsDraftFields(
  draft: NatsDraft,
): Omit<CarrierSetting, "kind" | "url"> {
  const session =
    draft.session === "fallback" ? {} : { session: draft.session };
  if (draft.signIn === "mint")
    return {
      ...session,
      mint: { account: draft.account.trim(), signingKey: draft.signingKey },
    };
  if (draft.signIn === "creds")
    return { ...session, jwt: draft.jwt.trim(), seed: draft.seed.trim() };
  return session;
}

function Choice<T extends string>({
  id,
  label,
  name,
  value,
  options,
  labels,
  onPick,
}: {
  id: string;
  label: string;
  /** The select's accessible name, when the visible label alone is ambiguous. */
  name?: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onPick: (value: T) => void;
}) {
  return (
    <div className="sw">
      <label className="sw__name" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="sw__select"
        aria-label={name}
        value={value}
        onChange={(event) => {
          const picked = options.find((entry) => entry === event.target.value);
          if (picked) onPick(picked);
        }}
      >
        {options.map((entry) => (
          <option key={entry} value={entry}>
            {labels[entry]}
          </option>
        ))}
      </select>
    </div>
  );
}

function Malformed({
  value,
  ok,
  label,
}: {
  value: string;
  ok: (value: string) => boolean;
  label: string;
}) {
  return value && !ok(value.trim()) ? (
    <StatusMark tone="err" label={label} />
  ) : null;
}

function MintFields({ draft, edit }: FieldsProps) {
  return (
    <>
      <FieldShell
        id="live-nats-account"
        label="Account public key"
        mono
        autoComplete="off"
        placeholder="A…"
        value={draft.account}
        onValueChange={(account) => edit({ account })}
        status={
          <Malformed
            value={draft.account}
            ok={isAccountKey}
            label="Not an account public key"
          />
        }
      />
      <FieldShell
        id="live-nats-signing-key"
        label="Account signing key"
        type="password"
        mono
        autoComplete="off"
        placeholder="SA…"
        value={draft.signingKey}
        onValueChange={(signingKey) => edit({ signingKey })}
        status={
          <Malformed
            value={draft.signingKey}
            ok={isAccountSeed}
            label="Not an account signing seed"
          />
        }
      />
    </>
  );
}

function CredsFields({ draft, edit }: FieldsProps) {
  return (
    <>
      <FieldShell
        id="live-nats-jwt"
        label="User JWT"
        mono
        autoComplete="off"
        value={draft.jwt}
        onValueChange={(jwt) => edit({ jwt })}
        status={
          <Malformed value={draft.jwt} ok={isUserJwt} label="Not a user JWT" />
        }
      />
      <FieldShell
        id="live-nats-seed"
        label="User seed"
        type="password"
        mono
        autoComplete="off"
        placeholder="SU…"
        value={draft.seed}
        onValueChange={(seed) => edit({ seed })}
        status={
          <Malformed
            value={draft.seed}
            ok={isUserSeed}
            label="Not a user seed"
          />
        }
      />
    </>
  );
}

type FieldsProps = {
  draft: NatsDraft;
  edit: (patch: Partial<NatsDraft>) => void;
};

/** The add form's NATS fields: sign-in, its keys, and the session route. */
export function NatsAddFields({ draft, edit }: FieldsProps) {
  return (
    <>
      <Choice
        id="live-nats-sign-in"
        label="Sign-in"
        value={draft.signIn}
        options={NATS_SIGN_INS}
        labels={SIGN_IN_LABELS}
        onPick={(signIn) => edit({ signIn })}
      />
      {draft.signIn === "mint" ? (
        <MintFields draft={draft} edit={edit} />
      ) : null}
      {draft.signIn === "creds" ? (
        <CredsFields draft={draft} edit={edit} />
      ) : null}
      <Choice
        id="live-nats-session"
        label="Session over this server"
        value={draft.session}
        options={NATS_SESSIONS}
        labels={SESSION_LABELS}
        onPick={(session) => edit({ session })}
      />
    </>
  );
}

/** A NATS row's session route, changed in place. */
export function NatsSessionChoice({
  carrier,
  at,
  change,
}: {
  carrier: CarrierSetting;
  at: number;
  change: Change;
}) {
  return (
    <Choice
      id={`live-nats-session-${at}`}
      label="Session over it"
      name={`Session over ${carrier.url}`}
      value={sessionOver(carrier)}
      options={NATS_SESSIONS}
      labels={SESSION_LABELS}
      onPick={(session) =>
        void change((now: LiveTransport) =>
          withCarrierSession(now, carrier, session),
        )
      }
    />
  );
}
