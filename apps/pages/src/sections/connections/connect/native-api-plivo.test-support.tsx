import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
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
export const plivoContracts: PrimaryContract[] = [
  {
    id: "plivo",
    name: "Plivo",
    origin: "https://api.plivo.com",
    authorization: `Basic ${btoa(`MAOWNED123:${primaryKey}`)}`,
    headers: { accept: "application/json" },
    parameters: { auth_id: "MAOWNED123" },
    verifyPath: "/v1/Account/MAOWNED123/",
    verifyReply: { auth_id: "MAOWNED123" },
    readPath: "/v1/Account/MAOWNED123/Number/?limit=20&offset=0",
    reply: {
      meta: {
        limit: 20,
        offset: 0,
        total_count: 100,
        next: "https://untrusted.example/next",
        previous: null,
      },
      objects: [
        {
          number: "18135401302",
          alias: null,
          application: "private-application",
          monthly_rental_rate: "private-cost",
        },
        {
          number: "+442012345678",
          alias: "<img src=x onerror=alert(1)>",
          sub_account: "private-account",
        },
      ],
    },
    action: "List rented phone numbers",
    operation: "provider.numbers.read",
    resultLabel: "Showing 2 rented phone numbers from first page",
  },
];

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
  await userEvent.type(
    screen.getByLabelText(/Auth ID$/),
    contract.parameters.auth_id,
  );
  await userEvent.type(screen.getByLabelText(/API key$/), primaryKey);
  await userEvent.click(
    screen.getByRole("button", { name: /^Verify and connect / }),
  );
  return screen.findByRole("button", { name: contract.action });
}
