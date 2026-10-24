import { TailscaleServerTrustConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { nativeNextValues } from "../connect/native-connector-ui-values.js";
import type {
  NativeField,
  NativeFieldValues,
} from "../connect/native-connector-ui.js";

export function serverTrustFields(
  label: string,
  certificateLabel: string,
  help: string,
): readonly NativeField[] {
  return [
    {
      id: "trustMode",
      label,
      kind: "choice",
      secret: false,
      required: true,
      choices: [
        { id: "public", label: "Public certificate authorities" },
        { id: "operator", label: "Operator certificate authority" },
      ],
    },
    {
      id: "operatorCAPEM",
      label: certificateLabel,
      kind: "textarea",
      secret: false,
      required: true,
      when: { fieldId: "trustMode", value: "operator" },
      help,
    },
  ];
}
export const peerTLSFields = serverTrustFields(
  "Tailnet service TLS trust",
  "Tailnet service CA certificates (PEM)",
  "Trust only these CA certificates for HTTPS services on the selected peer.",
);
export function peerTLSDraft(
  config?: TailscaleServerTrustConfiguration,
): NativeFieldValues {
  return {
    trustMode: config?.trustMode ?? "public",
    operatorCAPEM: config?.trustMode === "operator" ? config.operatorCAPEM : "",
  };
}
export function nextPeerTLSDraft(
  values: NativeFieldValues,
  id: string,
  value: string,
) {
  return nativeNextValues(peerTLSFields, values, id, value);
}
export function peerTLSConfiguration(
  values: NativeFieldValues,
): TailscaleServerTrustConfiguration | undefined {
  const candidate =
    values.trustMode === "operator"
      ? { trustMode: values.trustMode, operatorCAPEM: values.operatorCAPEM }
      : { trustMode: values.trustMode };
  const result = TailscaleServerTrustConfiguration.safeParse(candidate);
  if (!result.success)
    throw new Error("Choose peer TLS trust and provide valid CA certificates.");
  return result.data.trustMode === "public" ? undefined : result.data;
}
