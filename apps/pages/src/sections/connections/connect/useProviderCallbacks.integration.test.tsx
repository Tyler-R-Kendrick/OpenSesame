/** @vitest-environment jsdom */
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
} from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import {
  gitlabAccount,
  oauthDraft,
  oauthToken,
} from "@opensesame/app-core/lib/native-oauth.test-support.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { useProviderCallbacks } from "./useProviderCallbacks.js";
installConnectorIntegration();
function Callback({
  reload,
  onFlash,
}: { reload: () => Promise<void>; onFlash: (flash: Flash) => void }) {
  const location = useLocation();
  useProviderCallbacks(location.search, reload, onFlash);
  return (
    <output aria-label="Current route">
      {location.pathname}
      {location.search}
    </output>
  );
}
async function pending() {
  const saved = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(saved.connectionId);
  const transaction = loadNativeConnectorRecord(saved.connectionId)
    ?.privateState.pending.user;
  if (!transaction) throw new Error("Missing sealed transaction");
  return { saved, transaction };
}
function mount(
  search: string,
  onFlash = vi.fn<(flash: Flash) => void>(),
  reload = vi.fn(async () => {}),
) {
  const ui = render(
    <MemoryRouter initialEntries={[`/connections?${search}`]}>
      <Callback reload={reload} onFlash={onFlash} />
    </MemoryRouter>,
  );
  return { ui, onFlash, reload };
}
it("dispatches from sealed state, verifies the real provider response, scrubs the callback and rejects replay", async () => {
  const fixture = connectorIntegration();
  const { saved, transaction } = await pending();
  fixture.replies.push({ body: oauthToken() }, { body: gitlabAccount });
  const search = new URLSearchParams({
    native_state: transaction.state,
    native_code: "one-use-code",
    provider: "adobe",
    method: "mcp",
  }).toString();
  const first = mount(search);
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      `/connections/gitlab/${saved.connectionId}`,
    ),
  );
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(fixture.requests.map((request) => request.url)).toEqual([
    "https://gitlab.com/oauth/token",
    "https://gitlab.com/api/v4/user",
  ]);
  const exchange = fixture.requests[0];
  expect(exchange?.method).toBe("POST");
  expect(new URLSearchParams(await exchange?.text()).get("code")).toBe(
    "one-use-code",
  );
  expect(first.onFlash).toHaveBeenLastCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
  expect(fixture.scrubCallback).toHaveBeenCalled();
  expect(JSON.stringify(await fixture.reload())).not.toContain(
    "private-issued-access",
  );
  first.ui.unmount();
  const replay = mount(search);
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/connections",
    ),
  );
  expect(replay.onFlash).toHaveBeenLastCalledWith(
    expect.objectContaining({ tone: "err" }),
  );
  expect(fixture.requests).toHaveLength(2);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(JSON.stringify(replay.onFlash.mock.calls)).not.toContain(
    "one-use-code",
  );
});
it("rejects conflicting callback namespaces before either provider consumes authorization state", async () => {
  const fixture = connectorIntegration();
  const { saved, transaction } = await pending();
  const { onFlash } = mount(
    new URLSearchParams({
      native_state: transaction.state,
      native_code: "private-callback-code",
      linear_state: "another-provider-state",
      linear_code: "private-linear-code",
    }).toString(),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/connections",
    ),
  );
  expect(fixture.requests).toHaveLength(0);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending.user
      ?.state,
  ).toBe(transaction.state);
  expect(onFlash).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(onFlash.mock.calls)).not.toContain(
    "private-callback-code",
  );
  expect(JSON.stringify(onFlash.mock.calls)).not.toContain(
    "private-linear-code",
  );
});
it("consumes a provider refusal once and removes callback secrets without exchanging a token", async () => {
  const fixture = connectorIntegration();
  const { saved, transaction } = await pending();
  const callback = mount(
    new URLSearchParams({
      native_state: transaction.state,
      native_error: "access_denied",
      native_error_description: "private-provider-error",
    }).toString(),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/connections",
    ),
  );
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending.user,
  ).toBeUndefined();
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
  expect(fixture.requests).toHaveLength(0);
  expect(callback.onFlash).toHaveBeenLastCalledWith(
    expect.objectContaining({ tone: "err" }),
  );
  expect(JSON.stringify(callback.onFlash.mock.calls)).not.toContain(
    "private-provider-error",
  );
});

it("does not navigate or flash after the user leaves an in-flight callback", async () => {
  const fixture = connectorIntegration();
  const { saved, transaction } = await pending();
  let complete = (_response: Response) => {};
  const issued = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  fixture.route.respond = async (request) =>
    request.url.endsWith("/oauth/token")
      ? issued
      : Response.json(gitlabAccount);
  const onFlash = vi.fn();
  const reload = vi.fn(async () => {});
  function RoutedCallback() {
    const navigate = useNavigate();
    const location = useLocation();
    useProviderCallbacks(location.search, reload, onFlash);
    return (
      <>
        <output aria-label="Current route">
          {location.pathname}
          {location.search}
        </output>
        <button type="button" onClick={() => navigate("/settings")}>
          Leave callback
        </button>
      </>
    );
  }
  const search = new URLSearchParams({
    native_state: transaction.state,
    native_code: "late-one-use-code",
  });
  render(
    <MemoryRouter initialEntries={[`/connections?${search}`]}>
      <RoutedCallback />
    </MemoryRouter>,
  );
  await waitFor(() => expect(fixture.requests).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Leave callback" }));
  complete(Response.json(oauthToken()));
  await waitFor(() =>
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected"),
  );
  expect(screen.getByLabelText("Current route").textContent).toBe("/settings");
  expect(onFlash).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
