import type {
  CodeChannel,
  UnlockMethodId,
  WebauthnHostCheck,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { ReactNode } from "react";
import {
  IconConnection,
  IconMail,
  IconMessage,
  IconPhone,
  IconSecret,
  IconShield,
} from "../../../components/Icons.js";
import {
  ACCOUNT_TITLE,
  AccountFactorCeremony,
  type AccountMethodKind,
  isAccountMethod,
} from "./AccountFactorCeremony.js";
import type { RemovalFactor } from "./AccountFactorRemoval.js";
import {
  KEY_TITLE,
  KeyCeremony,
  type KeyKind,
  type KeyView,
  keyIcon,
} from "./KeyCeremony.js";
import {
  AuthenticatorCeremony,
  CodeCeremony,
  RecoveryCeremony,
} from "./SecondStepCeremonies.js";
import { ServiceCeremony } from "./ServiceCeremony.js";
import { SheetFrame } from "./SheetFrame.js";
import type { Run } from "./run.js";

export type MethodKind =
  | KeyKind
  | "totp"
  | CodeChannel
  | "recovery"
  | "service"
  | AccountMethodKind;
export type MethodView = KeyView;
/** A row of the Security list: a method the sheet handles, or the duress code. */
export type RowKind = MethodKind | "duress";

/**
 * What a row's action asked for: which method, and to do what with it —
 * plus, for one of the account's factors, which one.
 */
export type SheetRequest = {
  kind: MethodKind;
  view: MethodView;
  factor?: RemovalFactor;
};

const TITLE = {
  ...KEY_TITLE,
  totp: "Authenticator app",
  email: "Email code",
  sms: "Text message code",
  recovery: "Recovery codes",
  service: "Sign-in service",
  ...ACCOUNT_TITLE,
} satisfies Record<MethodKind, string>;

export function methodIcon(kind: RowKind, size = 16): ReactNode {
  switch (kind) {
    case "totp":
      return <IconPhone size={size} />;
    case "email":
      return <IconMail size={size} />;
    case "sms":
      return <IconMessage size={size} />;
    case "recovery":
      return <IconSecret size={size} />;
    case "service":
      return <IconConnection size={size} />;
    case "duress":
      return <IconShield size={size} />;
    case "account-totp":
      return <IconPhone size={size} />;
    case "account-passkey":
      return keyIcon("passkey", size);
    default:
      return keyIcon(kind, size);
  }
}

/**
 * The one sheet every method is added, changed or removed in — the side
 * sheet the Connectivity bar already opens, with a CeremonyShell card
 * inside. A row's action names what the sheet will do, and the card's facts
 * and keys say the rest (docs/design/canvases/auth-flow).
 */
export function MethodSheet({
  request,
  enrolled,
  host,
  busy,
  run,
  accountEmail,
  onClose,
}: {
  request: SheetRequest;
  enrolled: UnlockMethodId[];
  host: WebauthnHostCheck;
  busy: boolean;
  run: Run;
  /** The signed-in account's address, offered as a fill — never pre-filled. */
  accountEmail: string | null;
  onClose: () => void;
}) {
  const { kind, view } = request;

  let body: ReactNode;
  if (isAccountMethod(kind)) {
    body = (
      <AccountFactorCeremony
        kind={kind}
        view={view}
        factor={request.factor}
        busy={busy}
        run={run}
        onDone={onClose}
      />
    );
  } else if (kind === "passkey" || kind === "pin" || kind === "password") {
    body = (
      <KeyCeremony
        kind={kind}
        view={view}
        enrolled={enrolled}
        host={host}
        busy={busy}
        run={run}
        onDone={onClose}
      />
    );
  } else if (kind === "totp") {
    body = (
      <AuthenticatorCeremony
        view={view}
        enrolled={enrolled}
        host={host}
        busy={busy}
        run={run}
        onDone={onClose}
      />
    );
  } else if (kind === "service") {
    body = (
      <ServiceCeremony view={view} busy={busy} run={run} onDone={onClose} />
    );
  } else if (kind === "recovery") {
    body = <RecoveryCeremony busy={busy} run={run} />;
  } else {
    body = (
      <CodeCeremony
        channel={kind}
        view={view}
        busy={busy}
        run={run}
        accountEmail={accountEmail}
        onDone={onClose}
      />
    );
  }

  return (
    <SheetFrame
      title={TITLE[kind]}
      mark={methodIcon(kind, 20)}
      onClose={onClose}
    >
      {body}
    </SheetFrame>
  );
}
