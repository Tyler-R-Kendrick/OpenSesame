import { TailscaleHTTPRouteConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-peer-http.js";
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
    id: "routeMode",
    label: "Native HTTPS route",
    kind: "choice",
    secret: false,
    required: true,
    defaultValue: "exit",
    choices: [
      { id: "peer", label: "Approved tailnet peer" },
      { id: "exit", label: "Approved exit node" },
    ],
  },
  {
    id: "peerID",
    label: "Approved peer stable ID",
    kind: "text",
    secret: false,
    required: true,
    when: { fieldId: "routeMode", value: "peer" },
    help: "Use the stable node ID of the exact peer serving these HTTPS origins.",
  },
  {
    id: "exitNodeID",
    label: "Approved exit node ID",
    when: { fieldId: "routeMode", value: "exit" },
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
    help: "One HTTPS origin per line, followed by allowed destination CIDRs. Peer example: https://byo.example.com 100.64.0.1/32. Exit example: https://api.example.com 203.0.113.0/24.",
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
  config?: TailscaleHTTPRouteConfiguration,
): NativeFieldValues {
  return {
    mode: config ? "native" : "browser",
    routeMode: config?.version === 2 ? "peer" : "exit",
    peerID: config?.version === 2 ? config.peerID : "",
    exitNodeID: config?.version === 1 ? config.exitNodeID : "",
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
): TailscaleHTTPRouteConfiguration | undefined {
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
  if (values.routeMode && !["peer", "exit"].includes(values.routeMode))
    throw new Error("Choose an approved peer or exit route.");
  const route =
    values.routeMode === "peer"
      ? { version: 2, routeMode: "peer", peerID: values.peerID }
      : { version: 1, exitNodeID: values.exitNodeID };
  const configuration = {
    ...route,
    targets,
    trustMode: values.trustMode,
  };
  const result = TailscaleHTTPRouteConfiguration.safeParse(
    values.trustMode === "operator"
      ? { ...configuration, operatorCAPEM: values.operatorCAPEM }
      : configuration,
  );
  if (!result.success)
    throw new Error(
      "Complete the approved route identity, exact HTTPS origins, allowed destination CIDRs and selected TLS trust configuration.",
    );
  return result.data;
}
