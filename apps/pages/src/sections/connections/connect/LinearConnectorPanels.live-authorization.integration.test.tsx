import { nativeAuthChannel } from "@opensesame/app-core/browser/native-auth-message.js";
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { listConnections } from "@opensesame/app-core/lib/connections.js";
/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  applyLinearClientId,
  configureLinearConnector,
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
import { ConnectPanels, LinearLocalPanels } from "./ConnectPanels.js";
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

function LiveLinearSettings({
  onFlash,
  advanced,
}: {
  onFlash: (flash: Flash) => void;
  advanced: boolean;
}) {
  const provider = catalogProvider("linear");
  const plan = connectPlan("linear");
  if (!provider || !plan) throw new Error("Missing actual Linear provider");
  const [connections, setConnections] = useTailscaleConnections();
  const [selectedId, setSelectedId] = useState<string>();
  const [flash, setFlash] = useState<Flash | null>(null);
  const navigate = useNavigate();
  const reload = useCallback(async () => {
    const rows = await listConnections();
    setConnections(currentTailscaleConnections(rows));
  }, [setConnections]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const matches = (connections ?? []).filter(
    (row) => row.providerId === provider.id,
  );
  const selected = selectedId
    ? (matches.find((row) => row.connectionId === selectedId) ?? null)
    : matches.length === 1
      ? (matches[0] ?? null)
      : null;
  const Panels = advanced ? ConnectPanels : LinearLocalPanels;
  return (
    <>
      <button type="button" onClick={() => navigate("?view=other")}>
        Change route
      </button>
      <button
        type="button"
        onClick={() => setSelectedId(readDeviceRows().at(-1)?.connectionId)}
      >
        Select latest Linear
      </button>
      {flash ? <StatusMark tone={flash.tone} label={flash.text} /> : null}
      <output aria-label="Connections loaded">
        {connections === null ? "no" : "yes"}
      </output>
      <output aria-label="Selected Linear ID">
        {selected?.connectionId ?? "none"}
      </output>
      <Panels
        provider={provider}
        connection={selected}
        online
        plan={plan}
        onFlash={(next) => {
          setFlash(next);
          onFlash(next);
        }}
        onChanged={() => void reload()}
      />
    </>
  );
}

function fixture(advanced = false) {
  const actual = connectorIntegration();
  applyLinearClientId("registered-linear-live-projection");
  const windows: {
    close: ReturnType<typeof vi.fn>;
    rawClose: ReturnType<typeof vi.fn>;
    window: { closed: boolean };
    location: { href: string; replace: ReturnType<typeof vi.fn> };
  }[] = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    const transition = vi.fn();
    const popup = {
      opener: null,
      closed: false,
      close: vi.fn(() => {
        if (popup.closed) return;
        popup.closed = true;
        transition();
      }),
      location: { href: "about:blank", replace: vi.fn() },
    };
    windows.push({
      close: transition,
      rawClose: popup.close,
      window: popup,
      location: popup.location,
    });
    return overlapCast<typeof popup, Window>(popup);
  });
  const redirectUri = `${window.location.origin}/auth/native-connector.html`;
  const popup = nativeAuthPopupRuntime(actual.activation, redirectUri, () => {
    if (actual.activation.disposed())
      throw new Error("Actual connector activation ended");
  });
  releases.push(
    bindNativeOAuthBrowserPort({
      ...popup,
      redirectUri,
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
    }),
  );
  const onFlash = vi.fn<(flash: Flash) => void>();
  render(
    <MemoryRouter initialEntries={["/settings/connections/linear"]}>
      <LiveLinearSettings onFlash={onFlash} advanced={advanced} />
    </MemoryRouter>,
  );
  return { ...actual, windows, onFlash, advanced };
}

const loaded = () => screen.getByLabelText("Connections loaded").textContent;

it.each([false, true])(
  "keeps one originating Cancel after actual Linear creation auto-selects its committed row (Advanced: %s)",
  async (advanced) => {
    const actual = fixture(advanced);
    await waitFor(() => expect(loaded()).toBe("yes"));
    expect(readDeviceRows()).toHaveLength(0);
    if (advanced)
      await userEvent.click(
        screen.getByText("Advanced: existing OAuth app or API key"),
      );
    await userEvent.clear(screen.getByLabelText("Connector Name"));
    await userEvent.type(
      screen.getByLabelText("Connector Name"),
      "Live Linear",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create and authorize Linear" }),
    );
    await waitFor(() =>
      expect(actual.windows[0]?.location.replace).toHaveBeenCalledOnce(),
    );
    expect(readDeviceRows()).toHaveLength(1);
    const saved = readDeviceRows()[0];
    if (!saved) throw new Error("Missing actual committed Linear row");
    await waitFor(() =>
      expect(screen.getByLabelText("Selected Linear ID").textContent).toBe(
        saved.connectionId,
      ),
    );
    expect(
      readDeviceSecrets()[saved.connectionId]?.linear_pending,
    ).toBeTruthy();
    const firstPending =
      readDeviceSecrets()[saved.connectionId]?.linear_pending;
    expect(actual.windows).toHaveLength(1);
    expect(actual.windows[0]?.close).not.toHaveBeenCalled();
    expect(actual.requests).toHaveLength(0);
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Cancel sign-in" }),
      ).toHaveLength(1),
    );
    const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
    expect(cancel).toHaveProperty("disabled", false);
    await userEvent.click(cancel);
    await waitFor(() =>
      expect(actual.windows[0]?.close).toHaveBeenCalledOnce(),
    );
    expect(actual.windows[0]?.window.closed).toBe(true);
    await waitFor(() =>
      expect(
        readDeviceSecrets()[saved.connectionId]?.linear_pending,
      ).toBeUndefined(),
    );
    expect(actual.requests).toHaveLength(0);
    expect(readDeviceRows()).toHaveLength(1);
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");

    await startConsent(actual, 1);
    expect(readDeviceRows()).toHaveLength(1);
    expect(readDeviceRows()[0]?.connectionId).toBe(saved.connectionId);
    expect(readDeviceSecrets()[saved.connectionId]?.linear_pending).not.toBe(
      firstPending,
    );
    expect(actual.windows[1]?.window).not.toBe(actual.windows[0]?.window);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel sign-in" }),
    );
    await waitFor(() =>
      expect(actual.windows[1]?.close).toHaveBeenCalledOnce(),
    );
    expect(actual.windows[0]?.close).toHaveBeenCalledOnce();
  },
);

async function startConsent(actual: ReturnType<typeof fixture>, index = 0) {
  await waitFor(() => expect(loaded()).toBe("yes"));
  if (actual.advanced && !screen.queryByLabelText("Connector Name"))
    await userEvent.click(
      screen.getByText("Advanced: existing OAuth app or API key"),
    );
  await userEvent.click(
    screen.getByRole("button", {
      name: /^(Create|Save) and authorize Linear$/,
    }),
  );
  await waitFor(() =>
    expect(actual.windows[index]?.location.replace).toHaveBeenCalledOnce(),
  );
  await waitFor(() =>
    expect(readDeviceRows().map((row) => row.connectionId)).toContain(
      screen.getByLabelText("Selected Linear ID").textContent,
    ),
  );
  const id = screen.getByLabelText("Selected Linear ID").textContent;
  if (!id || id === "none") throw new Error("Actual selected Linear required");
  return id;
}

it.each([false, true])(
  "announces actual provider denial across its own remount and retries the same row with fresh state (Advanced: %s)",
  async (advanced) => {
    const actual = fixture(advanced);
    const id = await startConsent(actual);
    const pending = readDeviceSecrets()[id]?.linear_pending;
    const navigation = actual.windows[0]?.location.replace.mock.calls[0]?.[0];
    const authorization = new URL(String(navigation));
    const state = authorization.searchParams.get("state");
    const redirectUri = authorization.searchParams.get("redirect_uri");
    if (!state || !redirectUri)
      throw new Error("Actual Linear return target missing");
    const channel = new BroadcastChannel(await nativeAuthChannel(state));
    try {
      await act(async () =>
        channel.postMessage({
          kind: "authorization-code",
          redirectUri,
          receipt: "a".repeat(64),
          state,
          error: true,
          code: null,
        }),
      );
      await screen.findByRole("img", {
        name: "Linear authorization was declined; your connector is not authorized",
      });
      expect(actual.onFlash).toHaveBeenCalledWith({
        tone: "err",
        text: "Linear authorization was declined; your connector is not authorized",
      });
      expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
      expect(deviceConnection(id)?.status).toBe("pending");
      expect(await startConsent(actual, 1)).toBe(id);
      expect(readDeviceSecrets()[id]?.linear_pending).not.toBe(pending);
      expect(actual.windows[0]?.close).toHaveBeenCalledOnce();
      expect(actual.windows[1]?.close).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: "Cancel sign-in" }),
      );
      await waitFor(() =>
        expect(actual.windows[1]?.close).toHaveBeenCalledOnce(),
      );
      expect(actual.requests).toHaveLength(0);
    } finally {
      channel.close();
    }
  },
);

async function createOtherLinear() {
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Missing actual Linear plan");
  const fetcher = vi
    .spyOn(linearApiSeams, "fetch")
    .mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://api.linear.app/graphql");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "private-selection-B-key",
      );
      return Response.json({ data: linearUiAccount });
    });
  const saved = await configureLinearConnector(
    {
      ...initialDraftState(plan, "api-key"),
      name: "Actual selected B",
      key: "private-selection-B-key",
    },
    {
      mode: "byo",
      workspace: "",
      appScopes: ["read"],
      userScopes: [],
      webhookResourceTypes: [],
      icon: "",
    },
  );
  expect(fetcher).toHaveBeenCalledOnce();
  return saved.connectionId;
}

it.each(
  [false, true].flatMap((advanced) =>
    ["route", "lock", "removal", "selected B"].map((reason) => ({
      advanced,
      reason,
    })),
  ),
)(
  "withdraws only the originating pending Linear attempt on $reason (Advanced: $advanced)",
  async ({ reason, advanced }) => {
    const actual = fixture(advanced);
    const id = await startConsent(actual);
    expect(
      screen
        .getByRole("button", { name: "Remove connector" })
        .matches(":disabled"),
    ).toBe(true);
    let otherId: string | undefined;
    if (reason === "route")
      await userEvent.click(
        screen.getByRole("button", { name: "Change route" }),
      );
    else if (reason === "lock")
      await act(async () => vaultStore.lock({ recordLastVault: false }));
    else if (reason === "removal")
      await act(async () => revokeSelfHostedConnectorDurable(id));
    else {
      await act(async () => {
        otherId = await createOtherLinear();
      });
      expect(actual.windows[0]?.close).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: "Select latest Linear" }),
      );
    }
    await waitFor(() =>
      expect(actual.windows[0]?.close).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined(),
    );
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
    expect(actual.onFlash).not.toHaveBeenCalled();
    expect(actual.windows).toHaveLength(1);
    if (otherId) {
      expect(deviceConnection(otherId)?.status).toBe("active");
      expect(readDeviceSecrets()[otherId]?.linear_app_grant).toContain(
        "private-selection-B-key",
      );
    }
  },
);
