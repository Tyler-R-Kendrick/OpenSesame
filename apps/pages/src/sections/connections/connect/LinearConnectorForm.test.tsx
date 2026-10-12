/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { readDeviceSecrets } from "@opensesame/app-core/lib/device-connector-records.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { kvForgetAll, kvSeams } from "@opensesame/app-core/lib/kv.js";
import { applyLinearClientId } from "@opensesame/app-core/lib/linear-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinearConnectorForm } from "./LinearConnectorForm.js";
import { LinearFlashHarness } from "./linear-flash.test-support.js";

const found = connectPlan("linear");
if (!found) throw new Error("Linear plan required");
const plan = found;
function FormScope(props: ComponentProps<typeof LinearConnectorForm>) {
  return (
    <LinearFlashHarness>
      {(report) => (
        <LinearConnectorForm
          {...props}
          onFlash={(flash) => {
            report(flash);
            props.onFlash(flash);
          }}
        />
      )}
    </LinearFlashHarness>
  );
}

const originalFetch = linearApiSeams.fetch;
const originalWrite = kvSeams.kvSetDurable;
const account = {
  data: {
    viewer: {
      id: "person-1",
      name: "Provider verified person",
      email: "person@example.test",
    },
    organization: {
      id: "workspace-1",
      name: "Provider verified workspace",
      urlKey: "verified-workspace",
    },
    teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
  },
};

beforeEach(() => {
  kvForgetAll();
  clearNotices();
  applyLinearClientId(undefined);
});
afterEach(() => {
  cleanup();
  linearApiSeams.fetch = originalFetch;
  kvSeams.kvSetDurable = originalWrite;
  kvForgetAll();
  clearNotices();
});

async function fillKey() {
  await userEvent.click(screen.getByRole("radio", { name: "Bring Your Own" }));
  await userEvent.click(screen.getByRole("radio", { name: "API key" }));
  await userEvent.type(
    screen.getByLabelText("Linear API key"),
    "lin_api_test-only",
  );
}

it("verifies the actual provider account before reporting connection and hides the sealed key", async () => {
  const fetch = vi.fn<typeof linearApiSeams.fetch>(
    async () => new Response(JSON.stringify(account), { status: 200 }),
  );
  linearApiSeams.fetch = fetch;
  const onFlash = vi.fn();
  const onSaved = vi.fn();
  render(<FormScope plan={plan} onFlash={onFlash} onSaved={onSaved} />);
  await fillKey();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Linear" }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const connection = listDeviceConnections()[0];
  if (!connection) throw new Error("Verified connector was not saved");
  expect(connection).toMatchObject({
    status: "active",
    accountLabel: "Provider verified workspace",
  });
  expect(JSON.stringify(connection)).not.toContain("lin_api_test-only");
  expect(
    readDeviceSecrets()[connection.connectionId]?.linear_app_grant,
  ).toContain("lin_api_test-only");
  expect(screen.getByLabelText("Linear API key")).toHaveProperty("value", "");
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
  expect(onFlash.mock.calls[0]?.[0].text).toContain(
    "Provider verified workspace",
  );
});

it("refuses a wrong workspace or invalid key without clearing the draft or claiming connection", async () => {
  linearApiSeams.fetch = vi.fn(
    async () => new Response(JSON.stringify(account), { status: 200 }),
  );
  const onSaved = vi.fn();
  render(<FormScope plan={plan} onFlash={vi.fn()} onSaved={onSaved} />);
  await fillKey();
  await userEvent.type(
    screen.getByLabelText("Expected Linear workspace (optional)"),
    "different-workspace",
  );
  const connect = screen.getByRole("button", {
    name: "Verify and connect Linear",
  });
  await userEvent.click(connect);
  await waitFor(() => expect(listNotices()[0]?.body).toContain("workspace"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("img", { name: /workspace/ })).toBeTruthy();
  expect(JSON.stringify(listNotices())).not.toContain("lin_api_test-only");
  expect(listDeviceConnections()).toEqual([]);
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Linear API key")).toHaveProperty(
    "value",
    "lin_api_test-only",
  );
  await userEvent.clear(
    screen.getByLabelText("Expected Linear workspace (optional)"),
  );
  linearApiSeams.fetch = vi.fn(async () => new Response("", { status: 401 }));
  await userEvent.click(connect);
  await waitFor(() => expect(listNotices()[0]?.body).toContain("refused"));
  expect(
    screen.getByRole("img", {
      name: "Linear authorization expired or was refused. Reconnect Linear.",
    }),
  ).toBeTruthy();
  expect(listDeviceConnections()).toEqual([]);
  expect(onSaved).not.toHaveBeenCalled();
  expect(listNotices()).toHaveLength(1);
});

it("keeps the credential draft if encrypted storage fails after provider verification", async () => {
  linearApiSeams.fetch = vi.fn(
    async () => new Response(JSON.stringify(account), { status: 200 }),
  );
  kvSeams.kvSetDurable = vi
    .fn()
    .mockRejectedValue(new Error("Encrypted storage unavailable"));
  const onSaved = vi.fn();
  render(<FormScope plan={plan} onFlash={vi.fn()} onSaved={onSaved} />);
  await fillKey();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Linear" }),
  );
  await waitFor(() =>
    expect(listNotices()[0]?.body).toBe("Encrypted storage unavailable"),
  );
  expect(screen.getByLabelText("Linear API key")).toHaveProperty(
    "value",
    "lin_api_test-only",
  );
  expect(onSaved).not.toHaveBeenCalled();
  expect(listDeviceConnections()).toEqual([]);
});
