import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import { hasPendingGithubAppSecret } from "@opensesame/app-core/lib/github-app-secret.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { GithubAppForgetButton } from "./GithubAppConfigRows.js";
import { GithubAppConfigSummary } from "./GithubAppConfigSummary.js";
import { GithubAppRegistrationPanel } from "./GithubAppRegistrationPanel.js";
import { ConnectorModes } from "./connect/ConnectorModes.js";
import { NativeConnectorPanels } from "./connect/NativeConnectorPanels.js";
import { OutLink } from "./connect/fields.js";

type Method = "app" | "token";
const METHODS: readonly { id: Method; label: string }[] = [
  { id: "app", label: "GitHub App" },
  { id: "token", label: "Personal access token" },
];

/** Construct the installation destination from an App slug, never stored query data. */
function installationUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const slug = /^\/apps\/([a-z\d-]+)\/?$/iu.exec(url.pathname)?.[1];
    return url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      slug
      ? `https://github.com/apps/${slug}/installations/new`
      : null;
  } catch {
    return null;
  }
}

/** One shared configuration frame for App registration and native token access. */
export function GithubNativeAppPanels(props: {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [method, setMethod] = useState<Method>(() =>
    !new URLSearchParams(window.location.search).has("github_app") &&
    props.connection?.status === "active" &&
    readNativeConnector(props.connection.connectionId)?.configuration.method ===
      "api-key"
      ? "token"
      : "app",
  );
  const connectionId = props.connection?.connectionId;
  const connectionStatus = props.connection?.status;
  const savedNativeMethod =
    connectionStatus === "active" && connectionId
      ? readNativeConnector(connectionId)?.configuration.method
      : undefined;
  const previousConnection = useRef({
    id: connectionId,
    status: connectionStatus,
    method: savedNativeMethod,
  });
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = {
      id: connectionId,
      status: connectionStatus,
      method: savedNativeMethod,
    };
    const arrived =
      previous.id !== connectionId ||
      previous.status !== connectionStatus ||
      previous.method !== savedNativeMethod;
    if (
      arrived &&
      !new URLSearchParams(window.location.search).has("github_app") &&
      connectionStatus === "active" &&
      savedNativeMethod === "api-key"
    )
      setMethod("token");
  }, [connectionId, connectionStatus, savedNativeMethod]);
  const app = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );
  const install = installationUrl(app?.htmlUrl ?? null);
  return (
    <NativeConnectorPanels
      {...props}
      renderConfiguration={(form) => (
        <>
          <div className="panel__body cx-form">
            <ConnectorModes
              label="Connection method"
              value={method}
              options={METHODS}
              onChange={setMethod}
            />
            <div hidden={method !== "app"}>
              <GithubAppRegistrationPanel {...props} />
              {app ? (
                <>
                  <GithubAppConfigSummary
                    online={props.online}
                    onFlash={(flash) => {
                      if (flash) props.onFlash(flash);
                    }}
                  />
                  {hasPendingGithubAppSecret(app.id) ? (
                    <StatusMark
                      tone="warn"
                      label="GitHub App key pending vault storage."
                    />
                  ) : null}
                  <div className="actions">
                    {install ? (
                      <OutLink href={install}>Install GitHub App</OutLink>
                    ) : null}
                    <GithubAppForgetButton />
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div hidden={method !== "token"}>{form}</div>
        </>
      )}
    />
  );
}
