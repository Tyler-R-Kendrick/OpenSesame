import type {
  CodeChannel,
  UnlockMethodId,
  WebauthnHostCheck,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { type ReactNode, useState } from "react";
import {
  IconConnection,
  IconMail,
  IconMessage,
  IconPhone,
  IconSecret,
  IconShield,
} from "../../../components/Icons.js";
import {
  ACCOUNT_SUBTITLE,
  ACCOUNT_TITLE,
  AccountFactorCeremony,
  type AccountMethodKind,
  accountFoot,
  isAccountMethod,
} from "./AccountFactorCeremony.js";
import type { RemovalFactor } from "./AccountFactorRemoval.js";
import {
  KEY_SUBTITLE,
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

const SUBTITLE = {
  ...KEY_SUBTITLE,
  totp: "Codes from an app on your phone. The seed is sealed under the vault key.",
  email: "For a lost phone. Sent by your sign-in service.",
  sms: "For a lost phone. Sent by your sign-in service.",
  recovery: "Each stands in for the second step once.",
  service: "Where email and text codes are requested from.",
  ...ACCOUNT_SUBTITLE,
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
 * inside. A row's action names what the sheet will do; the sheet's foot
 * says what is and is not written yet (docs/design/canvases/auth-flow).
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
  const [foot, setFoot] = useState<string | null>(null);
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
        setFoot={setFoot}
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
        setFoot={setFoot}
      />
    );
  } else if (kind === "service") {
    body = (
      <ServiceCeremony view={view} busy={busy} run={run} onDone={onClose} />
    );
  } else if (kind === "recovery") {
    body = <RecoveryCeremony busy={busy} run={run} setFoot={setFoot} />;
  } else {
    body = (
      <CodeCeremony
        channel={kind}
        view={view}
        busy={busy}
        run={run}
        accountEmail={accountEmail}
        onDone={onClose}
        setFoot={setFoot}
      />
    );
  }

  return (
    <SheetFrame
      title={TITLE[kind]}
      subtitle={SUBTITLE[kind]}
      mark={methodIcon(kind, 20)}
      foot={foot ?? footFor(kind, view)}
      onClose={onClose}
    >
      {body}
    </SheetFrame>
  );
}

function footFor(kind: MethodKind, view: MethodView): string {
  if (isAccountMethod(kind)) return accountFoot(view);
  if (view === "remove") {
    return kind === "passkey" || kind === "pin" || kind === "password"
      ? "Removing a key does not touch the vault; it only stops opening it. The other keys keep working."
      : "Nothing else changes. Your keys keep working.";
  }
  if (view === "change") {
    return "The old one stops working the moment the new one is set.";
  }
  switch (kind) {
    case "totp":
      return "The seed lives only in memory until a code matches.";
    case "service":
      return "Saved on this device. Nothing is sent until you add an email or text code.";
    case "email":
    case "sms":
      return "Your sign-in service sends the code. The vault key never leaves this device.";
    case "recovery":
      return "Sealed under the vault key. A used code is crossed out here and refused at unlock.";
    default:
      return "Nothing changes until you press the button in the card. The vault stays unlocked while you do this.";
  }
}
