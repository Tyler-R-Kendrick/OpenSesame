import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { CATALOG_ROW_JSON } from "@opensesame/app-core/lib/connector-catalog.generated.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectionRouteProvider } from "@opensesame/app-core/sections/connections/provider-route.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { awsKmsConnectDependencies } from "./AwsKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { installConnectorIntegration } from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const originalIdentity = { ...identitySeams };
const originalVault = vaultHooksSeams.useVault;
const originalAws = { ...awsKmsConnectDependencies };

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  vaultHooksSeams.useVault = originalVault;
  Object.assign(awsKmsConnectDependencies, originalAws);
});

declareConnectionsTutorial();
installConnectorIntegration();

export function provider(id: string): Provider {
  const providers =
    id === "azure-kms"
      ? CATALOG_ROW_JSON.map((row) => JSON.parse(row) as Provider)
      : mergeVercelCatalog(getBundledProviders());
  const found = connectionRouteProvider(providers, id);
  if (!found) throw new Error(`${id} is not bundled`);
  return found;
}

export function draw(id: string, connection: Connection | null = null) {
  render(
    <MemoryRouter initialEntries={[`/settings/connections/${id}`]}>
      <ConnectorSettingsPage
        provider={provider(id)}
        providerId={id}
        connection={connection}
        connections={connection ? [connection] : []}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
}

/** A Host is named and a grant to it is live: it opens no connector road. */
export function nameAHostWithALiveGrant() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
}

export function unlocked() {
  awsKmsConnectDependencies.readAwsKmsConfig = async () => ({
    keyArn: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: null,
    label: null,
    configVersion: "0",
  });
  vaultHooksSeams.useVault = () => ({
    ...originalVault(),
    status: "unlocked",
    guest: false,
    tomb: "personal",
  });
}
