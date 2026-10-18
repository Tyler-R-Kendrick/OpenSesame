/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import { nativeAuthChannel } from "@opensesame/app-core/browser/native-auth-message.js";
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { listConnections } from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceSecrets } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  applyLinearClientId,
  configureLinearConnector,
  readLinearConnector,
} from "@opensesame/app-core/lib/linear-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { revokeSelfHostedConnectorDurable } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useEffect, useState } from "react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { StatusMark } from "../../../components/StatusMark.js";
import { nativeAuthPopupRuntime } from "../../../modules/connectors.external/native-auth-popup-runtime.js";
import {
  currentTailscaleConnections,
  useTailscaleConnections,
} from "../tailscale/useTailscaleConnectionState.js";
import { ConnectPanels } from "./ConnectPanels.js";
import { linearUiAccount } from "./linear-ui.test-support.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();
const releases: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  applyLinearClientId(undefined);
  vaultStore.lock({ recordLastVault: false });
});

function Settings({
  a,
  b,
  onFlash,
}: { a: string; b: string; onFlash: (flash: Flash) => void }) {
  const provider = catalogProvider("linear");
  if (!provider) throw new Error("Missing Linear catalog entry");
  const [rows, setRows] = useTailscaleConnections();
  const [selected, setSelected] = useState(a);
  const [flash, setFlash] = useState<Flash | null>(null);
  const navigate = useNavigate();
  const reload = useCallback(async () => {
    setRows(currentTailscaleConnections(await listConnections()));
  }, [setRows]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <>
      <button type="button" onClick={() => setSelected(b)}>
        Select B
      </button>
      <button type="button" onClick={() => navigate("?view=other")}>
        Change route
      </button>
      <output aria-label="Selected Linear ID">{selected}</output>
      {flash ? <StatusMark tone={flash.tone} label={flash.text} /> : null}
      <ConnectPanels
        provider={provider}
        connection={rows?.find((row) => row.connectionId === selected) ?? null}
        online
        onFlash={(next) => {
          setFlash(next);
          onFlash(next);
        }}
        onChanged={() => void reload()}
      />
    </>
  );
}

async function seedOAuth(name: string) {
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Missing actual Linear plan");
  const draft = initialDraftState(plan, "oauth");
  const saved = await configureLinearConnector(
    {
      ...draft,
      name,
      oauth: { ...draft.oauth, clientId: "registered-summary-client" },
    },
    {
      mode: "managed",
      workspace: "",
      appScopes: ["read"],
      userScopes: [],
      webhookResourceTypes: [],
      icon: "",
    },
  );
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  expect(readLinearConnector(saved.connectionId)?.app?.kind).toBe("oauth");
  expect(readDeviceSecrets()[saved.connectionId]?.linear_app_grant).toContain(
    "private-issued-",
  );
  return saved.connectionId;
}

async function fixture() {
  const actual = connectorIntegration();
  applyLinearClientId("registered-summary-client");
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(linearApiSeams, "fetch").mockImplementation(async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) === "https://api.linear.app/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
      return Response.json({
        access_token: `private-issued-${requests.length}`,
        refresh_token: `private-refresh-${requests.length}`,
        token_type: "Bearer",
        expires_in: 86400,
        scope: "read",
      });
    }
    if (String(url) === "https://api.linear.app/oauth/revoke")
      return Response.json(null);
    expect(String(url)).toBe("https://api.linear.app/graphql");
    return Response.json({ data: linearUiAccount });
  });
  const releaseSeed = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    authorize: async (_url, options) =>
      new URLSearchParams({
        native_state: options.state,
        native_code: "actual-provider-code",
      }).toString(),
  });
  let a: string;
  let b: string;
  try {
    a = await seedOAuth("OAuth A");
    b = await seedOAuth("OAuth B");
  } finally {
    releaseSeed();
  }
  const windows: {
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    location: { href: string; replace: ReturnType<typeof vi.fn> };
  }[] = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    const popup = {
      opener: null,
      closed: false,
      close: vi.fn(() => {
        popup.closed = true;
      }),
      location: { href: "about:blank", replace: vi.fn() },
    };
    windows.push(popup);
    return overlapCast<typeof popup, Window>(popup);
  });
  const redirectUri = "https://selfhost.example/auth/native-connector.html";
  releases.push(
    bindNativeOAuthBrowserPort({
      ...nativeAuthPopupRuntime(actual.activation, redirectUri, () => {
        if (actual.activation.disposed()) throw new Error("Activation ended");
      }),
      redirectUri,
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
    }),
  );
  const onFlash = vi.fn<(flash: Flash) => void>();
  const mounted = render(
    <MemoryRouter initialEntries={["/settings/connections/linear"]}>
      <Settings a={a} b={b} onFlash={onFlash} />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: "Reconnect application" });
  return { ...actual, a, b, windows, requests, onFlash, mounted };
}

async function renew(actual: Awaited<ReturnType<typeof fixture>>, index = 0) {
  await userEvent.click(
    screen.getByRole("button", { name: /^(Reconnect|Authorize) application$/ }),
  );
  await waitFor(() =>
    expect(actual.windows[index]?.location.replace).toHaveBeenCalledOnce(),
  );
  expect(
    readDeviceSecrets()[
      screen.getByLabelText("Selected Linear ID").textContent ?? ""
    ]?.linear_pending,
  ).toBeTruthy();
}

async function callback(
  actual: Awaited<ReturnType<typeof fixture>>,
  index: number,
  denied = false,
) {
  const url = new URL(
    String(actual.windows[index]?.location.replace.mock.calls[0]?.[0]),
  );
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!state || !redirectUri)
    throw new Error("Missing actual authorization target");
  const channel = new BroadcastChannel(await nativeAuthChannel(state));
  try {
    await act(async () =>
      channel.postMessage({
        kind: "authorization-code",
        state,
        redirectUri,
        receipt: "c".repeat(64),
        error: denied,
        code: denied ? null : "late-provider-code",
      }),
    );
  } finally {
    channel.close();
  }
}

it("withdraws saved OAuth A renewal on real B selection and leaves B's newer popup isolated from late A", async () => {
  const actual = await fixture();
  await renew(actual);
  expect(actual.windows[0]?.closed).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Select B" }));
  console.info("LINEAR_SUMMARY_SELECTION", {
    selected: screen.getByLabelText("Selected Linear ID").textContent,
    a: actual.a,
    b: actual.b,
    aClosed: actual.windows[0]?.closed,
    cancelCount: screen.queryAllByRole("button", { name: "Cancel sign-in" })
      .length,
  });
  await waitFor(() => expect(actual.windows[0]?.closed).toBe(true));
  await waitFor(() =>
    expect(readDeviceSecrets()[actual.a]?.linear_pending).toBeUndefined(),
  );
  const exchanges = actual.requests.filter((request) =>
    request.url.endsWith("/oauth/token"),
  ).length;
  await renew(actual, 1);
  const pendingB = readDeviceSecrets()[actual.b]?.linear_pending;
  await callback(actual, 0);
  expect(actual.windows[1]?.closed).toBe(false);
  expect(readDeviceSecrets()[actual.b]?.linear_pending).toBe(pendingB);
  expect(
    actual.requests.filter((request) => request.url.endsWith("/oauth/token")),
  ).toHaveLength(exchanges);
  expect(actual.onFlash).not.toHaveBeenCalled();
  await callback(actual, 1, true);
  await screen.findByRole("img", {
    name: "Linear authorization was declined; your connector is not authorized",
  });
  await waitFor(() =>
    expect(readDeviceSecrets()[actual.b]?.linear_pending).toBeUndefined(),
  );
  expect(
    actual.requests.filter((request) => request.url.endsWith("/oauth/token")),
  ).toHaveLength(exchanges);
  expect(actual.onFlash).toHaveBeenCalledOnce();
  await renew(actual, 2);
  expect(actual.windows[2]?.closed).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() =>
    expect(readDeviceSecrets()[actual.b]?.linear_pending).toBeUndefined(),
  );
  expect(actual.windows[2]?.closed).toBe(true);
});

it("makes same-ID form retry available after route withdrawal without remounting the originating form", async () => {
  const actual = await fixture();
  await renew(actual);
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() =>
    expect(readDeviceSecrets()[actual.a]?.linear_pending).toBeUndefined(),
  );
  const form = document.querySelector("#connector form");
  await userEvent.click(
    screen.getByRole("button", { name: "Save and authorize Linear" }),
  );
  await waitFor(() =>
    expect(actual.windows[1]?.location.replace).toHaveBeenCalledOnce(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Change route" }));
  await waitFor(() =>
    expect(readDeviceSecrets()[actual.a]?.linear_pending).toBeUndefined(),
  );
  expect(document.querySelector("#connector form")).toBe(form);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save and authorize Linear" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save and authorize Linear" }),
  );
  await waitFor(() =>
    expect(actual.windows[2]?.location.replace).toHaveBeenCalledOnce(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() =>
    expect(readDeviceSecrets()[actual.a]?.linear_pending).toBeUndefined(),
  );
  expect(actual.windows[2]?.closed).toBe(true);
});

it.each(["route", "lock", "removal", "unmount"])(
  "withdraws the exact saved actor renewal on %s without stale feedback",
  async (reason) => {
    const actual = await fixture();
    await renew(actual);
    const tokenRequests = actual.requests.filter((request) =>
      request.url.endsWith("/oauth/token"),
    ).length;
    expect(actual.windows[0]?.closed).toBe(false);
    if (reason === "route")
      await userEvent.click(
        screen.getByRole("button", { name: "Change route" }),
      );
    else if (reason === "lock")
      await act(async () => vaultStore.lock({ recordLastVault: false }));
    else if (reason === "removal")
      await act(async () => revokeSelfHostedConnectorDurable(actual.a));
    else actual.mounted.unmount();
    await waitFor(() => expect(actual.windows[0]?.closed).toBe(true));
    await waitFor(() =>
      expect(readDeviceSecrets()[actual.a]?.linear_pending).toBeUndefined(),
    );
    expect(actual.onFlash).not.toHaveBeenCalled();
    expect(
      actual.requests.filter((request) => request.url.endsWith("/oauth/token")),
    ).toHaveLength(tokenRequests);
    if (reason !== "route") return;
    await renew(actual, 1);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel sign-in" }),
    );
    await waitFor(() =>
      expect(readDeviceSecrets()[actual.a]?.linear_pending).toBeUndefined(),
    );
    expect(actual.windows[1]?.closed).toBe(true);
  },
);
