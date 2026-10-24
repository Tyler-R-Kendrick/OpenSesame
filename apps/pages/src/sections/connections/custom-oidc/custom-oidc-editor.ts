import {
  type OidcConnectorConfig,
  type OidcDeviceAuthorization,
  type OidcTokens,
  beginOidcDevice,
  oidcConnectorItem,
  pollOidcDevice,
} from "@opensesame/app-core/lib/custom-oidc.js";
import { useState } from "react";
import type { useVaultStore } from "../../../lib/vault/hooks.js";

const EMPTY: OidcConnectorConfig = {
  name: "",
  issuer: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  jwksUri: "",
  deviceAuthorizationEndpoint: "",
  clientId: "",
  clientSecret: "",
  callbackUrl: "",
  tokenRelayUrl: "",
  scopes: ["openid", "profile", "email"],
  tokenAuth: "client_secret_post",
};

export function useCustomOidcConfig() {
  const [config, setConfig] = useState(EMPTY);
  const set = <K extends keyof OidcConnectorConfig>(
    key: K,
    value: OidcConnectorConfig[K],
  ) => setConfig((current) => ({ ...current, [key]: value }));
  return { config, set, setConfig };
}

type DeviceEditorState = {
  setBusy: (value: boolean) => void;
  setFailure: (value: string | null) => void;
  setDevice: (value: OidcDeviceAuthorization | null) => void;
  setTokens: (value: OidcTokens) => void;
  setSaved: (value: boolean) => void;
};

export async function startOidcDeviceAuthorization(
  config: OidcConnectorConfig,
  store: ReturnType<typeof useVaultStore>,
  state: DeviceEditorState,
) {
  const { setBusy, setFailure, setDevice, setTokens, setSaved } = state;
  setBusy(true);
  setFailure(null);
  try {
    const authorization = await beginOidcDevice(config);
    setDevice(authorization);
    window.open(
      authorization.verificationUriComplete ?? authorization.verificationUri,
      "_blank",
      "noopener,noreferrer",
    );
    let interval = authorization.intervalSeconds;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      const result = await pollOidcDevice(config, authorization);
      if (result.status === "pending") {
        interval = result.intervalSeconds;
        continue;
      }
      setTokens(result.tokens);
      await store.addItems([oidcConnectorItem(config, result.tokens)]);
      setSaved(true);
      setDevice(null);
      break;
    }
  } catch (error) {
    setFailure(
      error instanceof Error ? error.message : "Device authorization failed",
    );
  } finally {
    setBusy(false);
  }
}
