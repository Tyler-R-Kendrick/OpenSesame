import { identityConnectionUsesBroker } from "@opensesame/app-core/lib/identity-connections-schema.js";
import { IdentityProtocolFields } from "./IdentityProtocolFields.js";
import {
  type IdentityServiceFieldProps,
  IdentityServiceFields,
} from "./IdentityServiceFields.js";
export function IdentityConnectionFields(props: IdentityServiceFieldProps) {
  return (
    <>
      <IdentityProtocolFields
        draft={props.draft}
        busy={props.busy}
        onChange={props.onChange}
      />
      {identityConnectionUsesBroker(props.draft) ? (
        <IdentityServiceFields {...props} />
      ) : null}
    </>
  );
}
