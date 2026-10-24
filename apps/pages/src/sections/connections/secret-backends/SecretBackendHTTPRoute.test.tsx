/** @vitest-environment jsdom */
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  type TailscaleNodeSnapshot,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { savedBrowserNodeConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  SecretBackendHTTPRoute,
  secretBackendHTTPOrigins,
} from "./SecretBackendHTTPRoute.js";

let release = () => {};
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  cleanup();
  release();
  release = () => {};
  await fixture.close();
});
function bindNode() {
  const state: TailscaleNodeSnapshot = {
    status: "stopped",
    hostname: "",
    controlURL: "",
    authURL: "",
    addresses: [],
    peerCount: 0,
    failure: "",
  };
  const node: TailscaleBrowserNode = {
    snapshot: () => state,
    subscribe: () => () => {},
    start: async () => {},
    stop: () => {},
    forget: async () => {},
    login: () => {},
    get: async () => ({ status: 200, text: "" }),
  };
  release = bindTailscaleBrowserNode(node);
}
function route(
  draft: Parameters<typeof SecretBackendHTTPRoute>[0]["draft"],
  busy = false,
) {
  return (
    <MemoryRouter>
      <SecretBackendHTTPRoute draft={draft} online busy={busy} />
    </MemoryRouter>
  );
}
function open() {
  const summary = screen.getByText("HTTPS connection route");
  const details = summary.closest("details");
  if (!details) throw new Error("Missing route controls");
  details.open = true;
  fireEvent(details, new Event("toggle", { bubbles: true }));
}
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it("derives both actual Bitwarden region origins, deduplicates a self-hosted origin and never substitutes defaults", () => {
  const draft = {
    ...secretBackendDraft("bitwarden"),
    baseUrl: "https://api.bitwarden.eu",
    identityUrl: "https://identity.bitwarden.eu",
  };
  expect(secretBackendHTTPOrigins(draft)).toEqual({
    complete: true,
    origins: ["https://api.bitwarden.eu", "https://identity.bitwarden.eu"],
  });
  expect(
    secretBackendHTTPOrigins({
      ...draft,
      baseUrl: "https://vault.example/api",
      identityUrl: "https://vault.example/identity",
    }),
  ).toEqual({ complete: true, origins: ["https://vault.example"] });
  expect(
    secretBackendHTTPOrigins({ ...draft, identityUrl: "" })?.complete,
  ).toBe(false);
});
it("uses the exact operator 1Password account and configured Proton API region without exposing tokens", () => {
  const one = {
    ...secretBackendDraft("1password"),
    baseUrl: "https://operator.1password.eu",
    token: "never-render-this-service-account-token",
  };
  const { rerender } = render(route(one));
  expect(screen.getByText("https://operator.1password.eu")).toBeTruthy();
  expect(screen.queryByText(one.token)).toBeNull();
  expect(screen.queryByText("https://my.1password.com")).toBeNull();
  const proton = {
    ...secretBackendDraft("proton-pass"),
    mode: "proton-pass" as const,
    baseUrl: "https://regional.proton.example/api",
  };
  rerender(route(proton));
  expect(screen.getByText("https://regional.proton.example")).toBeTruthy();
  expect(
    secretBackendHTTPOrigins({
      ...one,
      baseUrl: "https://user:secret@team.example",
    })?.complete,
  ).toBe(false);
  expect(
    secretBackendHTTPOrigins({ ...one, baseUrl: "https://team.example/path" })
      ?.complete,
  ).toBe(false);
});
it("opens the real shared exit controls, saves approved configuration in the genuine vault and does not claim provider authentication", async () => {
  const draft = {
    ...secretBackendDraft("bitwarden"),
    baseUrl: "https://api.bitwarden.eu",
    identityUrl: "https://identity.bitwarden.eu",
  };
  bindNode();
  render(route(draft));
  expect(screen.queryByLabelText("Integration HTTP transport")).toBeNull();
  open();
  await waitFor(() =>
    expect(
      screen.getByLabelText("Browser node hostname").matches(":disabled"),
    ).toBe(false),
  );
  field("Browser node hostname", "provider-exit-browser");
  field("Integration HTTP transport", "native");
  field("Approved exit node ID", "operator-approved-exit");
  field(
    "Integration origins and destination CIDRs",
    "https://api.bitwarden.eu 203.0.113.0/24\nhttps://identity.bitwarden.eu 198.51.100.0/24",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save browser node configuration" }),
  );
  await waitFor(() =>
    expect(savedBrowserNodeConfiguration()?.nativeHTTP).toEqual({
      version: 1,
      exitNodeID: "operator-approved-exit",
      trustMode: "public",
      targets: [
        { origin: draft.baseUrl, prefixes: ["203.0.113.0/24"] },
        { origin: draft.identityUrl, prefixes: ["198.51.100.0/24"] },
      ],
    }),
  );
  expect(screen.queryByText("Secret backend session connected")).toBeNull();
  expect(fixture.fetcher).not.toHaveBeenCalled();
  await act(async () => vaultStore.lock());
  expect(
    screen
      .getByRole("button", { name: "Save browser node configuration" })
      .matches(":disabled"),
  ).toBe(true);
});
it("keeps active provider route editing disabled and leaves offline/local backends without network controls", async () => {
  const draft = {
    ...secretBackendDraft("infisical"),
    baseUrl: "https://provider.example",
  };
  bindNode();
  const { rerender } = render(route(draft, true));
  open();
  expect(
    screen
      .getByRole("group", { name: "Shared HTTPS route configuration" })
      .hasAttribute("disabled"),
  ).toBe(true);
  rerender(route({ ...draft, mode: "file-import" }));
  expect(screen.queryByText("HTTPS connection route")).toBeNull();
});

it("keeps Networking activation in Features and follows unsaved endpoint edits without admitting a route", () => {
  const draft = {
    ...secretBackendDraft("infisical"),
    baseUrl: "https://original.example/api",
  };
  const { rerender } = render(route(draft));
  open();
  expect(
    screen
      .getByRole("link", { name: "Configure Networking in Features" })
      .getAttribute("href"),
  ).toBe("/settings/features#feature-networking");
  expect(screen.queryByLabelText("Integration HTTP transport")).toBeNull();
  rerender(route({ ...draft, baseUrl: "https://unsaved.example:9443/api" }));
  expect(screen.getByText("https://unsaved.example:9443")).toBeTruthy();
  expect(screen.queryByText("https://original.example")).toBeNull();
  expect(savedBrowserNodeConfiguration()).toBeNull();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});
