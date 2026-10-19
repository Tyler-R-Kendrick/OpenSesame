import { configureHost } from "@opensesame/app-core/host.js";
import {
  UNAVAILABLE_LABEL,
  leadingUnavailableKind,
} from "@opensesame/app-core/lib/browser-disposition.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { screen, within } from "@testing-library/react";
/** Real capability-owned drivers for the catalog form contract; no provider requests on render. */
import { expect, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { genuineRuntimeFixture } from "../../../modules/connectors.external/genuine-runtime.test-support.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeOAuthRuntime } from "../../../modules/connectors.external/native-oauth-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";

export async function activateNativePanelRuntime() {
  configureHost(createTestHost());
  await genuineRuntimeFixture();
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
  fetch: Awaited<ReturnType<typeof activateNativePanelRuntime>>["fetch"],
) {
  const offered = descriptor.methods.filter((method) => method.available);
  expect(
    within(panel).getByRole("group", {
      name: `${descriptor.name} configuration`,
    }),
  ).toBeTruthy();
  if (offered.length) {
    expect(within(panel).queryByLabelText("Connector name")).toBeNull();
    expect(panel.querySelector('input[type="file"]')).toBeNull();
    const authorizes = offered.some(
      (method) =>
        method.authorizeFirst ?? ["oauth", "oidc", "mcp"].includes(method.id),
    );
    const commit = within(panel).getByRole("button", {
      name: `${authorizes ? "Sign in to" : "Verify and connect"} ${descriptor.name}`,
    });
    expect(commit).toBeTruthy();
    if (panel.querySelector('input[type="password"]'))
      expect(commit).toHaveProperty("disabled", true);
    for (const method of offered) {
      const choice = within(panel).queryByRole("radio", { name: method.label });
      if (offered.length > 1) expect(choice).toHaveProperty("disabled", false);
      else expect(choice).toBeNull();
    }
  } else {
    // With nothing to connect, the lone status names the specific reason when
    // one is known, and says the generic sentence only when none is.
    const kinds = descriptor.methods.map((method) => method.unavailableKind);
    expect(
      within(panel).getByRole("img", {
        name: kinds.some((kind) => kind !== undefined)
          ? `${descriptor.name}: ${UNAVAILABLE_LABEL[leadingUnavailableKind(kinds)]}`
          : `${descriptor.name} has no supported browser connection method.`,
      }),
    ).toBeTruthy();
    // ... and the reasons are open: they are all the page has to say.
    expect(panel.querySelector("details[open] > summary")?.textContent).toBe(
      "Why not",
    );
    expect(panel.querySelector('input[type="password"]')).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: /^Verify and connect/ }),
    ).toBeNull();
  }
  for (const method of descriptor.methods.filter((item) => !item.available)) {
    expect(
      within(panel).queryByRole("radio", { name: method.label }),
    ).toBeNull();
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
