import { screen, within } from "@testing-library/react";
/** Real capability-owned drivers for the catalog form contract; no provider requests on render. */
import { expect, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeOAuthRuntime } from "../../../modules/connectors.external/native-oauth-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";

export function activateNativePanelRuntime() {
  const test = createTestContext();
  const fetch = vi.fn<typeof test.ctx.egress.fetch>(async () => {
    throw new Error(
      "Provider HTTP requires an explicit fixture and human action",
    );
  });
  const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch } };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeApiRuntime(activation);
  bindNativeOAuthRuntime(activation);
  return { activation, fetch };
}

export function expectNativePanel(
  panel: HTMLElement,
  descriptor: NativeConnectorDescriptor,
  fetch: ReturnType<typeof activateNativePanelRuntime>["fetch"],
) {
  const offered = descriptor.methods.filter((method) => method.available);
  expect(
    within(panel).getByRole("group", {
      name: `${descriptor.name} configuration`,
    }),
  ).toBeTruthy();
  if (offered.length) {
    expect(within(panel).getByLabelText("Connector name")).toHaveProperty(
      "value",
      descriptor.name,
    );
    const commit = within(panel).getByRole("button", {
      name: `Verify and connect ${descriptor.name}`,
    });
    expect(commit).toBeTruthy();
    if (panel.querySelector('input[type="password"]'))
      expect(commit).toHaveProperty("disabled", true);
    for (const method of offered)
      expect(
        within(panel).getByRole("radio", {
          name: method.label,
        }),
      ).toHaveProperty("disabled", false);
  } else {
    expect(
      within(panel).getByRole("img", {
        name: `${descriptor.name} has no supported browser connection method.`,
      }),
    ).toBeTruthy();
    expect(panel.querySelector('input[type="password"]')).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: /^Verify and connect/ }),
    ).toBeNull();
  }
  for (const method of descriptor.methods.filter((item) => !item.available)) {
    expect(
      within(panel).getByRole("radio", { name: method.label }),
    ).toHaveProperty("disabled", true);
    expect(
      within(panel).getByText(
        `${method.label}: ${method.unavailableReason ?? "Unavailable on this device."}`,
      ),
    ).toBeTruthy();
  }
  expect(
    screen.queryByText(/Vercel access token|Relay management key/),
  ).toBeNull();
  expect(
    screen.queryByRole("img", {
      name: `${descriptor.name} connected`,
    }),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
}
