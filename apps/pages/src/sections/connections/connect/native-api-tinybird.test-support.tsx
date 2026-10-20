import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import {
  nativeApiFingerprint,
  nativeApiTarget,
} from "@opensesame/app-core/lib/native-api-target.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import {
  hasConnectRoute,
  mergeVercelCatalog,
} from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import {
  type PrimaryContract,
  primaryKey,
} from "./native-api-primary.test-support.js";
export const tinybirdContracts: PrimaryContract[] = [
  "api.tinybird.co",
  "api.us-east.tinybird.co",
].map((host) => ({
  id: "tinybird",
  name: "Tinybird",
  origin: `https://${host}`,
  authorization: `Bearer ${primaryKey}`,
  parameters: { api_host: host },
  verifyPath: "/v0/datasources?attrs=name",
  readPath: "/v0/datasources?attrs=name",
  verifyReply: { datasources: [] },
  reply: {
    datasources: Array.from({ length: 37 }, (_, i) => ({
      name: i === 0 ? "<img src=x onerror=alert(1)>" : `source_${i}`,
      headers: { authorization: "private-token" },
      columns: [{ name: "private-column" }],
      statistics: { rows: 100 },
      url: "https://untrusted.example",
    })),
  },
  action: "List data sources",
  operation: "provider.datasources.read",
  resultLabel: "Showing 20 of 37 returned data sources",
}));
export function mount(contract: PrimaryContract, id?: string) {
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === contract.id,
  );
  if (!provider) throw new Error("Missing actual catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  return {
    ...render(
      <MemoryRouter initialEntries={[`/settings/connections/${contract.id}`]}>
        <ConnectorSettingsPage
          provider={provider}
          providerId={provider.id}
          connection={id ? deviceConnection(id) : null}
          connections={[]}
          loading={false}
          online
          canConfigure
          configureHint=""
          flash={null}
          rememberOffer={null}
          onFlash={onFlash}
          onRememberOffer={() => {}}
          onChanged={onChanged}
        />
      </MemoryRouter>,
    ),
    onFlash,
    onChanged,
  };
}
export async function fill(contract: PrimaryContract) {
  const method = screen.queryByRole("radio", { name: "API Key" });
  if (method) await userEvent.click(method);
  await userEvent.selectOptions(
    screen.getByLabelText(/Data region$/),
    contract.parameters.api_host,
  );
  await userEvent.type(screen.getByLabelText(/API key$/), primaryKey);
  await userEvent.click(
    screen.getByRole("button", { name: /^Verify and connect / }),
  );
  return screen.findByRole("button", { name: contract.action });
}
/** Reproduce the exact historical fixed-EU metadata in the real sealed ledger. */
export async function stageOldContract(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing saved Tinybird record");
  const target = nativeApiTarget("tinybird", {});
  if (!target.profile.verify) throw new Error("Missing Tinybird verification");
  const classification = {
    publicParameters: [],
    privateCredentials: ["api_key"],
  };
  const fingerprint = await nativeApiFingerprint({
    ...target,
    parameters: {},
    classification,
    profile: {
      ...target.profile,
      templateParams: [],
      verify: {
        ...target.profile.verify,
        url: "https://api.tinybird.co/v0/sql?q=SELECT+1",
        requiredFields: [],
      },
    },
  });
  await updateNativeConnector(
    id,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    classification,
    (current) => {
      current.configuration.parameters = {};
      current.configuration.fingerprint = fingerprint;
      for (const grant of Object.values(current.privateState.grants))
        grant.fingerprint = fingerprint;
      if (current.privateState.verification)
        current.privateState.verification.fingerprint = fingerprint;
      return current;
    },
  );
  const old = loadNativeConnectorRecord(id);
  if (!old) throw new Error("Historical Tinybird connection disappeared");
  return old;
}
