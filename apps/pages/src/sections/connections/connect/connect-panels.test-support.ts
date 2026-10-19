import {
  UNAVAILABLE_LABEL,
  leadingUnavailableKind,
} from "@opensesame/app-core/lib/browser-disposition.js";
import { fireEvent, screen, within } from "@testing-library/react";
/** Real capability-owned drivers for the catalog form contract; no provider requests on render. */
import { expect, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeOAuthRuntime } from "../../../modules/connectors.external/native-oauth-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import {
  type NativeConnectorDescriptor,
  nativeMethodConfigurable,
} from "./native-connector-ui.js";

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
  const offered = descriptor.methods.filter(nativeMethodConfigurable);
  expect(
    within(panel).getByRole("group", {
      name: `${descriptor.name} configuration`,
    }),
  ).toBeTruthy();
  if (offered.length) {
    expect(within(panel).queryByLabelText("Connector name")).toBeNull();
    expect(panel.querySelector('input[type="file"]')).toBeNull();
    const selected =
      offered.length === 1
        ? offered[0]
        : offered.find((method) =>
            within(panel).queryByRole("radio", {
              name: method.label,
              checked: true,
            }),
          );
    if (!selected)
      throw new Error("The actual configuration selection is missing");
    const authorizes =
      selected.authorizeFirst ?? ["oauth", "oidc", "mcp"].includes(selected.id);
    const commit = within(panel).getByRole("button", {
      name: `${authorizes ? "Sign in to" : "Verify and connect"} ${descriptor.name}`,
    });
    expect(commit).toBeTruthy();
    if (!selected.available || panel.querySelector('input[type="password"]'))
      expect(commit).toHaveProperty("disabled", true);
    for (const method of offered) {
      const choice = within(panel).queryByRole("radio", { name: method.label });
      if (offered.length > 1) expect(choice).toHaveProperty("disabled", false);
      else expect(choice).toBeNull();
    }
    expectUnavailableOperationsBlocked(panel, descriptor, offered, fetch);
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
  for (const method of descriptor.methods.filter(
    (item) => !nativeMethodConfigurable(item),
  )) {
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

function expectUnavailableOperationsBlocked(
  panel: HTMLElement,
  descriptor: NativeConnectorDescriptor,
  offered: NativeConnectorDescriptor["methods"],
  fetch: ReturnType<typeof activateNativePanelRuntime>["fetch"],
) {
  for (const method of offered.filter((item) => !item.available)) {
    const choice = within(panel).queryByRole("radio", { name: method.label });
    if (choice) fireEvent.click(choice);
    const signsIn =
      method.authorizeFirst ?? ["oauth", "oidc", "mcp"].includes(method.id);
    const unavailable = within(panel).getByRole("button", {
      name: `${signsIn ? "Sign in to" : "Verify and connect"} ${descriptor.name}`,
    });
    expect(unavailable).toHaveProperty("disabled", true);
    fireEvent.click(unavailable);
    const form = panel.querySelector("form");
    if (!form) throw new Error("Configurable method is missing its real form");
    fireEvent.submit(form);
    expect(fetch).not.toHaveBeenCalled();
  }
}
