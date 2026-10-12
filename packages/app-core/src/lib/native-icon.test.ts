import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import {
  installNativeApiTests,
  nativeAnswers,
  nativeApiDraft,
} from "./native-api.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { configureNativeGithubPersonal } from "./native-github-personal.js";
import { nativeUploadedIcon } from "./native-icon.test-support.js";
import { configureNativeLocalInstance } from "./native-local-instance.js";

installNativeApiTests();
type IconRoute = {
  provider: string;
  body: BoundaryValue;
  configure: (
    icon: string,
    token: string,
    transport: NativeProviderTransport,
  ) => Promise<{ connectionId: string }>;
};
const routes: IconRoute[] = [
  {
    provider: "GitHub",
    body: { id: 12345, login: "octocat", type: "User" },
    configure: (icon, token, transport) =>
      configureNativeGithubPersonal(
        { ...nativeApiDraft("github"), icon, credentials: { api_key: token } },
        transport,
      ),
  },
  {
    provider: "generic API",
    body: { data: [] },
    configure: (icon, token, transport) =>
      configureNativeApiConnector(
        { ...nativeApiDraft("openai"), icon, credentials: { api_key: token } },
        transport,
      ),
  },
  {
    provider: "Vault token",
    body: {
      data: {
        entity_id: "user-1",
        display_name: "Engineer",
        policies: ["default"],
        ttl: 3600,
        renewable: true,
      },
    },
    configure: (icon, apiKey, transport) =>
      configureNativeLocalInstance(
        {
          providerId: "vault",
          displayName: "Vault",
          icon,
          endpoint: "https://vault.example.org",
          namespace: "",
          apiKey,
        },
        transport,
      ),
  },
];
it.each(routes)(
  "persists a real uploaded PNG above the text limit for $provider",
  async (route) => {
    expect(nativeUploadedIcon.length).toBeGreaterThan(4096);
    const provider = nativeAnswers({ body: route.body });
    const saved = await route.configure(
      nativeUploadedIcon,
      "private-native-key",
      provider.transport,
    );
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.configuration.icon,
    ).toBe(nativeUploadedIcon);
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each(routes)(
  "rejects a $provider image that reflects its secret before provider egress",
  async (route) => {
    const secret = "iVBORw0KGgo";
    const provider = nativeAnswers({ body: route.body });
    await expect(
      route.configure(nativeUploadedIcon, secret, provider.transport),
    ).rejects.toThrow("expected response");
    expect(provider.fetch).not.toHaveBeenCalled();
  },
);
it("retains provider text limits and rejects external or oversized icons", () => {
  expect(() => safeProviderText("x".repeat(4097), {})).toThrow(
    "expected response",
  );
  expect(() =>
    safeNativeConnectorIcon("https://evil.test/icon.png", {}),
  ).toThrow("expected response");
  expect(() =>
    safeNativeConnectorIcon(nativeUploadedIcon.repeat(350), {}),
  ).toThrow("expected response");
});
it("rejects manual Vault names that expose the retained provider token before lookup", async () => {
  const provider = nativeAnswers();
  await expect(
    configureNativeLocalInstance(
      {
        providerId: "vault",
        displayName: "hvs.private-token",
        icon: "",
        endpoint: "https://vault.example.org",
        namespace: "",
        apiKey: "hvs.private-token",
      },
      provider.transport,
    ),
  ).rejects.toThrow("expected response");
  expect(provider.fetch).not.toHaveBeenCalled();
});
