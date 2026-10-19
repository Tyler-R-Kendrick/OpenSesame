/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  installConnectorIntegration,
  integrationProvider,
} from "./native-connector-integration.test-support.js";
import {
  apiKey,
  applicationKey,
  closeDatadogOracles,
  datadogOracle,
  deferred,
  draft,
  monitors,
  saved,
  sites,
} from "./native-datadog.integration.test-support.js";

installConnectorIntegration();
afterEach(closeDatadogOracles);
const result = {
  label: "Showing 2 monitors from first page",
  items: monitors.map((monitor) => ({
    id: String(monitor.id),
    label: monitor.name,
  })),
};
function mount() {
  const onFlash = vi.fn();
  const view = render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("datadog")}
        connection={null}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  return { ...view, onFlash };
}
async function connect(site: string = sites[0]) {
  await userEvent.selectOptions(screen.getByLabelText("Datadog site"), site);
  await userEvent.type(screen.getByLabelText("Datadog API key"), apiKey);
  await userEvent.type(
    screen.getByLabelText("Application key"),
    applicationKey,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Datadog" }),
  );
  return screen.findByRole("button", { name: "List monitors" });
}
it("uses both sealed saved keys and the selected EU site through common configuration, real monitor action and cold reload", async () => {
  const o = await datadogOracle();
  mount();
  const action = await connect("datadoghq.eu");
  expect(screen.queryByText("Check Datadog access")).toBeNull();
  await userEvent.click(action);
  const section = await screen.findByRole("region", { name: result.label });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(monitors.map((monitor) => monitor.name));
  expect(section.querySelector("img, a")).toBeNull();
  for (const secret of [apiKey, applicationKey]) {
    expect(section.textContent).not.toContain(secret);
    expect([...o.fixture.disk.files.values()].join()).not.toContain(secret);
    expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
  }
  expect(screen.getByLabelText("Datadog API key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Application key")).toHaveProperty("value", "");
  await o.fixture.reload();
  await userEvent.click(screen.getByRole("button", { name: "List monitors" }));
  await waitFor(() => expect(o.requests).toHaveLength(3));
  expect(o.requests.map((row) => row.path)).toEqual([
    "/api/v2/validate_keys",
    "/api/v1/monitor?page=0&page_size=20",
    "/api/v1/monitor?page=0&page_size=20",
  ]);
  expect(o.requests.every((row) => row.authorized && row.bytes === 0)).toBe(
    true,
  );
  expect(o.origins).toEqual(
    Array.from({ length: 3 }, () => "https://api.datadoghq.eu"),
  );
  expect(
    (await screen.findByRole("region", { name: result.label })).textContent,
  ).toContain("Queue depth");
});
it("retains each of the nine saved site origins and both fixed pagination parameters", async () => {
  const o = await datadogOracle();
  for (const site of sites) {
    const s = await saved(site);
    expect(await s.read()).toEqual(result);
  }
  expect(o.origins).toEqual(
    sites.flatMap((site) => [`https://api.${site}`, `https://api.${site}`]),
  );
  expect(o.requests.every((row) => row.authorized && row.bytes === 0)).toBe(
    true,
  );
});
it("returns genuine empty and single-monitor first pages without implying a full organization count", async () => {
  const o = await datadogOracle();
  const s = await saved();
  o.reply([]);
  expect(await s.read()).toEqual({
    label: "Showing 0 monitors from first page",
    items: [],
  });
  o.reply([{ id: Number.MAX_SAFE_INTEGER, name: "Largest exact ID" }]);
  expect(await s.read()).toEqual({
    label: "Showing 1 monitor from first page",
    items: [{ id: "9007199254740991", label: "Largest exact ID" }],
  });
});
it.each(
  [
    {},
    [{ id: "1", name: "wrong type" }],
    [{ id: 0, name: "zero" }],
    [{ id: -1, name: "negative" }],
    [{ id: 1.5, name: "fraction" }],
    [{ id: Number.MAX_SAFE_INTEGER + 1, name: "unsafe" }],
    [monitors[0], monitors[0]],
    [{ id: 1, name: "" }],
    [{ id: 1, name: "bad\nlabel" }],
    [{ id: 1, name: "bad\u007flabel" }],
    [{ id: 1, name: "x".repeat(4097) }],
    Array.from({ length: 21 }, (_, id) => ({ id: id + 1, name: "Too many" })),
    [{ id: 1, name: apiKey }],
    [{ id: 1, name: applicationKey }],
    [{ id: 1, name: encodeURIComponent(applicationKey) }],
  ].map((body) => ({ body })),
)(
  "refuses malformed, duplicate, oversized or credential-reflecting monitor payload %#",
  async ({ body }) => {
    const o = await datadogOracle();
    const s = await saved();
    o.reply(body);
    await expect(s.read()).rejects.toMatchObject({
      code: "response",
      message: "Provider did not return the expected response",
    });
  },
);
it.each([
  [401, "authorization"],
  [403, "permission"],
  [429, "rate-limit"],
  [500, "response"],
] as const)(
  "preserves actual provider HTTP%s and never exposes either secret in errors",
  async (status, code) => {
    const o = await datadogOracle();
    const s = await saved();
    o.reply({ errors: [apiKey, applicationKey] }, status);
    await expect(s.read()).rejects.toMatchObject({ code, status });
    expect(readNativeConnector(s.view.connectionId)?.status).toBe(
      status === 401 ? "reauthorize" : "connected",
    );
  },
);
it("requires both configured keys and refuses arbitrary caller URLs, pagination or operations before dispatch", async () => {
  const o = await datadogOracle();
  for (const [name, value] of [
    ["api_key", apiKey],
    ["application_key", applicationKey],
  ] as const)
    await expect(
      configureNativeApiConnector({
        ...draft(),
        credentials: { [name]: value },
      }),
    ).rejects.toThrow();
  expect(o.requests).toHaveLength(0);
  const s = await saved();
  for (const [name, value] of [
    ["url", "https://other.example"],
    ["page", "1"],
    ["page_size", "10000"],
    ["api_key", "override"],
  ] as const)
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.monitors.read", {
        [name]: value,
      }),
    ).rejects.toThrow("does not accept");
  await expect(
    s.driver.invoke(s.view.connectionId, "provider.monitors.delete", {}),
  ).rejects.toThrow("Unsupported");
  expect(o.requests).toHaveLength(1);
});
it("accepts exactly twenty distinct monitor records as one bounded first page", async () => {
  const o = await datadogOracle();
  const s = await saved();
  const page = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    name: `Monitor ${index + 1}`,
  }));
  o.reply(page);
  expect(await s.read()).toEqual({
    label: "Showing 20 monitors from first page",
    items: page.map((item) => ({ id: String(item.id), label: item.name })),
  });
});
it("bounds an actual held TLS body at256KiB and closes the physical stream", async () => {
  const o = await datadogOracle();
  const s = await saved();
  const drained = deferred();
  o.hold((response) => {
    response.once("close", drained.resolve);
    response.write(`[{"id":1,"name":"${"x".repeat(256 * 1024)}`);
  });
  await expect(s.read()).rejects.toMatchObject({ code: "response" });
  await drained.promise;
});
it("rejects a late result when saved site and connection revision change during the read", async () => {
  const o = await datadogOracle();
  const s = await saved();
  const arrived = deferred();
  let finish = () => {};
  o.hold((response) => {
    finish = () => response.end(JSON.stringify(monitors));
    arrived.resolve();
  });
  const rejected = expect(s.read()).rejects.toThrow("changed");
  await arrived.promise;
  await configureNativeApiConnector({
    ...draft("us3.datadoghq.com"),
    connectionId: s.view.connectionId,
    revision: s.view.revision,
  });
  finish();
  await rejected;
  expect(o.origins).toEqual([
    "https://api.datadoghq.com",
    "https://api.datadoghq.com",
    "https://api.us3.datadoghq.com",
  ]);
});
it("drains a held original operation on activation withdrawal and refuses retained driver reuse", async () => {
  const o = await datadogOracle();
  const s = await saved();
  const arrived = deferred();
  const drained = deferred();
  o.hold((response) => {
    response.once("close", drained.resolve);
    response.write("[");
    arrived.resolve();
  });
  const rejected = expect(s.read()).rejects.toThrow();
  await arrived.promise;
  o.fixture.activation.dispose();
  await rejected;
  await drained.promise;
  await expect(s.read()).rejects.toThrow();
  expect(o.requests).toHaveLength(2);
});
it("uses the saved native route with zero browser fallback, retains caller cancellation, and rejects a withdrawn original node", async () => {
  const o = await datadogOracle(true);
  const s = await saved("datadoghq.eu");
  expect(await s.read()).toEqual(result);
  const arrived = deferred();
  const state = { closed: false };
  o.hold((response) => {
    response.once("close", () => {
      state.closed = true;
    });
    response.write("[");
    arrived.resolve();
  });
  const caller = new AbortController();
  const rejected = expect(s.read(caller.signal)).rejects.toThrow();
  await arrived.promise;
  const start = performance.now();
  caller.abort();
  await rejected;
  await waitFor(() => expect(state.closed).toBe(true), {
    timeout: 2000,
    interval: 10,
  });
  expect(performance.now() - start).toBeLessThan(2000);
  const captured = o.node?.capture.mock.calls.length;
  await expect(s.read(caller.signal)).rejects.toThrow();
  expect(o.node?.capture).toHaveBeenCalledTimes(captured ?? 0);
  expect(await s.read()).toEqual(result);
  o.node?.lifetime.abort();
  await expect(s.read()).rejects.toThrow();
  expect(o.browserFetch).not.toHaveBeenCalled();
  expect(o.requests).toHaveLength(4);
});
