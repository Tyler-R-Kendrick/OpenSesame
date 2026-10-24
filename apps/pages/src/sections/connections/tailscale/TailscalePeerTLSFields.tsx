import { NativeInputFields } from "../connect/NativeConnectorFields.js";
import type { NativeFieldValues } from "../connect/native-connector-ui.js";
import { peerTLSFields } from "./tailscale-server-trust-values.js";

export function TailscalePeerTLSFields({
  values,
  onChange,
  disabled,
}: {
  values: NativeFieldValues;
  onChange: (id: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="cx-block" disabled={disabled}>
      <legend>Tailnet service HTTPS</legend>
      <NativeInputFields
        fields={peerTLSFields}
        values={values}
        onChange={onChange}
      />
    </fieldset>
  );
}
