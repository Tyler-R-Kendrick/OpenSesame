/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { hasNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { nativeKeyDriverFor } from "@opensesame/app-core/lib/native-key-drivers.js";
import { expect, it } from "vitest";
import { catalogConnectorAction } from "../catalog-connector-action.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { nativePublicUrl } from "./native-connector-ui-values.js";
import { nativeKeyActions } from "./native-key-descriptor.js";

installConnectorIntegration();

it("advertises the actual default issuer driver and its shared configuration before any provider request", () => {
  const fixture = connectorIntegration();
  const provider = catalogProvider("google-wallet");
  if (!provider) throw new Error("Actual Google Wallet catalog entry required");
  expect(nativeKeyDriverFor(provider.id)?.family).toBe("Google Wallet");
  expect(hasNativeConnectorDriver("api-key", provider.id)).toBe(true);
  expect(catalogConnectorAction(provider, null)).toMatchObject({
    kind: "connect",
    method: "api-key",
  });
  const descriptor = nativeSettingsDescriptor(provider);
  expect(descriptor?.methods).toHaveLength(1);
  expect(descriptor?.methods[0]).toMatchObject({
    available: true,
    id: "api-key",
    label: "Issuer service account",
  });
  expect(
    descriptor?.methods[0]?.fields.map(({ id, secret }) => ({ id, secret })),
  ).toEqual([
    { id: "issuer_id", secret: false },
    { id: "class_id", secret: false },
    { id: "origin", secret: false },
    { id: "service_account_json", secret: true },
  ]);
  expect(fixture.requests).toHaveLength(0);
});

it("composes only a driver's explicit handoff origins and leaves other key actions without links", () => {
  const wallet = nativeKeyDriverFor("google-wallet");
  const secrets = nativeKeyDriverFor("gcp");
  if (!wallet || !secrets)
    throw new Error("Actual compiled key drivers required");
  const action = nativeKeyActions(wallet.ui("google-wallet"))[0];
  expect(action?.resultOrigins).toEqual(["https://pay.google.com"]);
  expect(
    nativePublicUrl(
      "https://pay.google.com/gp/v/save/signed",
      action?.resultOrigins,
    ),
  ).toBe("https://pay.google.com/gp/v/save/signed");
  for (const value of [
    "https://pay.google.com.evil.test/gp/v/save/signed",
    "https://pay.google.com@evil.test/",
    "http://pay.google.com/gp/v/save/signed",
    "javascript:alert(1)",
  ])
    expect(nativePublicUrl(value, action?.resultOrigins)).toBeNull();
  for (const read of nativeKeyActions(secrets.ui("gcp"))) {
    expect(read.resultOrigins).toEqual([]);
    expect(
      nativePublicUrl(
        "https://pay.google.com/gp/v/save/signed",
        read.resultOrigins,
      ),
    ).toBeNull();
  }
});
