import { NativeInputFields } from "../connect/NativeConnectorFields.js";
import type { NativeFieldValues } from "../connect/native-connector-ui.js";
import {
  nativeHTTPModeFields,
  nativeHTTPRouteFields,
} from "./tailscale-native-http-values.js";

export function TailscaleNativeHTTPFields({
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
      <legend>Integration HTTP connections</legend>
      <NativeInputFields
        fields={nativeHTTPModeFields}
        values={values}
        onChange={onChange}
      />
      {values.mode === "native" ? (
        <NativeInputFields
          fields={nativeHTTPRouteFields}
          values={values}
          onChange={onChange}
        />
      ) : null}
    </fieldset>
  );
}
