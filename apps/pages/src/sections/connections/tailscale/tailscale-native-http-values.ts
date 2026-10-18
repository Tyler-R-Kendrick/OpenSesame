import { TailscaleNativeHTTPConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { nativeNextValues } from "../connect/native-connector-ui-values.js";
import type {
  NativeField,
  NativeFieldValues,
} from "../connect/native-connector-ui.js";

export const nativeHTTPModeFields: readonly NativeField[] = [
  {
    id: "mode",
    label: "Integration HTTP transport",
    kind: "choice",
    secret: false,
    required: true,
    choices: [
      { id: "browser", label: "Browser HTTPS" },
      { id: "native", label: "Tailscale browser node" },
    ],
    help: "Choose the transport for explicitly configured integration origins.",
  },
];
export const nativeHTTPRouteFields: readonly NativeField[] = [
  {
    id: "exitNodeID",
    label: "Approved exit node ID",
    kind: "text",
    secret: false,
    required: true,
    help: "Use the stable ID of the exit node approved for this browser session.",
  },
  {
    id: "targets",
    label: "Integration origins and destination CIDRs",
    kind: "textarea",
    secret: false,
    required: true,
    help: "One HTTPS origin per line, followed by its allowed destination CIDRs. Example: https://api.example.com 203.0.113.0/24, 2001:db8::/32",
  },
  {
    id: "trustMode",
    label: "Integration TLS trust",
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
    label: "Operator CA certificates (PEM)",
    kind: "textarea",
    secret: false,
    required: true,
    when: { fieldId: "trustMode", value: "operator" },
    help: "Trust only the supplied CA certificates for these integration origins.",
  },
];
export function nativeHTTPDraft(
  config?: TailscaleNativeHTTPConfiguration,
): NativeFieldValues {
  return {
    mode: config ? "native" : "browser",
    exitNodeID: config?.exitNodeID ?? "",
    trustMode: config?.trustMode ?? "public",
    operatorCAPEM: config?.trustMode === "operator" ? config.operatorCAPEM : "",
    targets:
      config?.targets
        .map((target) => `${target.origin} ${target.prefixes.join(", ")}`)
        .join("\n") ?? "",
  };
}
export function nextNativeHTTPDraft(
  values: NativeFieldValues,
  id: string,
  value: string,
) {
  if (id === "mode" && value === "browser") return nativeHTTPDraft();
  return nativeNextValues(
    [...nativeHTTPModeFields, ...nativeHTTPRouteFields],
    values,
    id,
    value,
  );
}
export function nativeHTTPConfiguration(
  values: NativeFieldValues,
): TailscaleNativeHTTPConfiguration | undefined {
  if (values.mode === "browser") return undefined;
  if (values.mode !== "native")
    throw new Error("Choose an integration HTTP transport.");
  const targets = (values.targets ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [origin = "", ...prefixes] = line.trim().split(/[\s,]+/);
      return { origin, prefixes };
    });
  const result = TailscaleNativeHTTPConfiguration.safeParse({
    version: 1,
    exitNodeID: values.exitNodeID,
    targets,
    trustMode: values.trustMode,
    ...(values.trustMode === "operator"
      ? { operatorCAPEM: values.operatorCAPEM }
      : {}),
  });
  if (!result.success)
    throw new Error(
      "Complete the approved exit node, exact HTTPS origins, masked destination CIDRs and selected TLS trust configuration.",
    );
  return result.data;
}
