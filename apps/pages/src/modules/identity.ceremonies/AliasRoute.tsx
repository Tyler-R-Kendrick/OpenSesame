/**
 * `/guest` and `/delegate` (ADR 0140 §1, D5, D12): two names for roads the
 * app already has, not ceremonies of their own. The core boot takes either
 * out of the address before the first paint (`app-core/lib/ceremony-aliases.ts`)
 * — a delegation link's bearer into Join's invite capture, a guest arrival
 * into a note the guest road reads — and leaves the base. This route answers
 * only an address boot did not see: it does the same, then goes to the base,
 * where the unlock screen opens Join with the invite or lands the keyboard on
 * the guest road (drawn only while the operator allows guests).
 *
 * It renders nothing, reads no vault key and writes nothing (ADR 0140 §2).
 */

import { captureAliasArrivalFromPage } from "@opensesame/app-core/lib/ceremony-aliases.js";
import { useEffect } from "react";
import { useNavigate } from "react-router";

export function AliasRoute() {
  const navigate = useNavigate();
  useEffect(() => {
    captureAliasArrivalFromPage();
    navigate("/", { replace: true });
  }, [navigate]);
  return null;
}
