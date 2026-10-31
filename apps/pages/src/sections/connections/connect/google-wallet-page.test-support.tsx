import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  walletClass,
  walletIssuer,
  walletOracle,
  walletOrigin,
} from "@opensesame/app-core/lib/native-google-wallet.test-support.js";
import { localVaultSessionGuard } from "@opensesame/app-core/lib/secret-backends/local-vault-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeCleanupRuntime } from "../../../modules/connectors.external/native-cleanup-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

// Match real-browser encoder/typed-array realms for jose's actual signing path.
beforeEach(() =>
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor),
);
installConnectorIntegration();
const activations: Array<() => void> = [];
const oracles: Awaited<ReturnType<typeof walletOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of activations.splice(0).reverse()) dispose();
  for (const oracle of oracles.splice(0).reverse()) await oracle.close();
});
export async function oracle() {
  const fixture = connectorIntegration();
  const o = await walletOracle();
  oracles.push(o);
  fixture.activation.dispose();
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  fixture.activation = activation;
  const owner = new AbortController();
  const session = localVaultSessionGuard(vaultStore);
  const stop = vaultStore.onLock(() => owner.abort());
  const signal = AbortSignal.any([owner.signal, o.owner.signal]);
  const carrier = {
    ...o.transport,
    signal,
    assertCurrent: () => {
      signal.throwIfAborted();
      session.current();
      o.transport.assertCurrent();
      if (activation.disposed())
        throw new Error("Original wallet activation ended");
    },
  };
  activation.onDispose(() => {
    owner.abort();
    stop();
    session.close();
  });
  activation.onDispose(bindNativeProviderTransport(carrier));
  bindNativeApiRuntime(activation);
  bindNativeCleanupRuntime(activation, ["google-wallet"]);
  activations.push(activation.dispose);
  return { ...o, fixture };
}

export function mount(id?: string) {
  const provider = catalogProvider("google-wallet");
  if (!provider)
    throw new Error("Missing actual Google Wallet catalog provider");
  const onFlash = vi.fn();
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/google-wallet"]}>
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
          onChanged={() => {}}
        />
      </MemoryRouter>,
    ),
    onFlash,
  };
}
export async function enter(account: string) {
  await userEvent.type(screen.getByLabelText("Issuer ID"), walletIssuer);
  await userEvent.type(screen.getByLabelText("Generic class ID"), walletClass);
  await userEvent.type(
    screen.getByLabelText("Presenting HTTPS origin"),
    walletOrigin,
  );
  await userEvent.click(screen.getByLabelText("Service account JSON key"));
  await userEvent.paste(account);
}
export async function fill(account: string) {
  await enter(account);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Google Wallet" }),
  );
}
export async function connect(account: string) {
  await fill(account);
  return screen.findByText("Prepare a Google Wallet pass", {
    selector: "summary",
  });
}
export async function prepare() {
  const summary = screen.getByText("Prepare a Google Wallet pass", {
    selector: "summary",
  });
  if (!summary.closest("details")?.open) await userEvent.click(summary);
  for (const [label, value] of [
    ["Public pass title", "Research access"],
    ["Public pass header", "Operator pass"],
  ]) {
    const field = screen.getByLabelText(label);
    await userEvent.clear(field);
    await userEvent.type(field, value);
  }
  await userEvent.click(
    screen.getByRole("button", { name: "Prepare a Google Wallet pass" }),
  );
}
