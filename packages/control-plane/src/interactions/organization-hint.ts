import { isString } from "@opensesame/os-domain";
import type { InteractionDetails } from "./types.js";

/** Select the saved tenant's hosted form; every POST still checks its authority. */
export function organizationHintForDetails(
  details: InteractionDetails,
): string | undefined {
  const hint = isString(details.params.login_hint_provider)
    ? details.params.login_hint_provider
    : isString(details.params.kc_idp_hint)
      ? details.params.kc_idp_hint
      : "";
  return /^org:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(hint)?.[1];
}
