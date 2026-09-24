import type { UnlockMethodId } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { ReactNode } from "react";
import {
  IconLock,
  IconPasskey,
  IconShield,
} from "../../../components/Icons.js";

/** The three keys that open a vault, named the way every sheet names them. */
export type KeyKind = UnlockMethodId;
export type KeyView = "add" | "change" | "remove";

export const KEY_NOUN = {
  passkey: "passkey",
  pin: "PIN",
  password: "password",
} satisfies Record<KeyKind, string>;

export const KEY_TITLE = {
  passkey: "Passkey",
  pin: "PIN",
  password: "Password",
} satisfies Record<KeyKind, string>;

export const KEY_SUBTITLE = {
  passkey: "Face, fingerprint or the device PIN, through this browser.",
  pin: "Four to twelve digits, held on this device.",
  password: "Twelve characters or more. The reminder you save shows at unlock.",
} satisfies Record<KeyKind, string>;

export function keyIcon(kind: KeyKind, size = 16): ReactNode {
  return kind === "passkey" ? (
    <IconPasskey size={size} />
  ) : kind === "pin" ? (
    <IconLock size={size} />
  ) : (
    <IconShield size={size} />
  );
}
