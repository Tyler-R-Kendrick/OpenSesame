import {
  guestsAllowed,
  subscribeGuestAccess,
} from "@opensesame/app-core/lib/guest-access.js";
import { useSyncExternalStore } from "react";

/** Whether the guest road is offered; true unless an operator turned it off. */
export function useGuestsAllowed(): boolean {
  return useSyncExternalStore(subscribeGuestAccess, guestsAllowed, () => true);
}
