/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorRecovery } from "./NativeConnectorRecovery.js";
import { nativeVerified } from "./native-connector-ui-values.js";
import type { NativeConnectorController } from "./native-connector-ui.js";
import {
  nativeUiController,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

function revocationContext(canConfirm = true) {
  const view = nativeUiView();
  view.status = "cleanup";
  view.verifiedAt = null;
  view.recovery = [
    {
      id: "authorization-1",
      kind: "configure",
      label: "Provider authorization",
      detail:
        "Revoke the indeterminate application authorization at the provider.",
    },
  ];
  const controller = {
    ...nativeUiController(view),
    revocationInstructions: vi.fn(() => ({
      url: "https://www.spotify.com/account/apps/",
      message:
        "Revoke the application in provider settings. Confirmation does not verify a working connection.",
      canConfirm,
    })),
    confirmRevocation: vi.fn(async () => {
      view.recovery = [];
      view.status = "configuration";
      return view;
    }),
  };
  return { view, controller };
}

it("requires an explicit human statement and separate confirmation before clearing provider cleanup", async () => {
  const { view, controller } = revocationContext();
  const onChanged = vi.fn();
  render(
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      onChanged={onChanged}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("link", { name: "Open provider revocation instructions" })
      .getAttribute("href"),
  ).toBe("https://www.spotify.com/account/apps/");
  const confirm = screen.getByRole("button", {
    name: "Confirm provider revocation",
  });
  expect(confirm).toHaveProperty("disabled", true);
  await userEvent.click(
    screen.getByRole("link", { name: "Open provider revocation instructions" }),
  );
  expect(controller.confirmRevocation).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I revoked this application at the provider",
    }),
  );
  expect(controller.confirmRevocation).not.toHaveBeenCalled();
  await userEvent.click(confirm);
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(controller.confirmRevocation).toHaveBeenCalledWith("authorization-1");
  expect(controller.retry).not.toHaveBeenCalled();
  expect(nativeVerified(view)).toBe(false);
  expect(onChanged).toHaveBeenCalledWith(
    expect.objectContaining({ status: "configuration", verifiedAt: null }),
  );
});

it("uses the provider's token acknowledgement and requires an explicit confirmation", async () => {
  const context = revocationContext();
  const controller: NativeConnectorController = {
    ...context.controller,
    revocationInstructions: () => ({
      url: "https://openbao.org/api-docs/auth/token/#revoke-a-token",
      message:
        "Ask the instance administrator to revoke this connection token.",
      canConfirm: true,
      acknowledgementLabel:
        "An administrator revoked this connection token or confirmed it is expired",
    }),
  };
  render(
    <NativeConnectorRecovery
      view={context.view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  const confirm = screen.getByRole("button", {
    name: "Confirm provider revocation",
  });
  expect(confirm).toHaveProperty("disabled", true);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "An administrator revoked this connection token or confirmed it is expired",
    }),
  );
  expect(context.controller.confirmRevocation).not.toHaveBeenCalled();
  await userEvent.click(confirm);
  await waitFor(() =>
    expect(context.controller.confirmRevocation).toHaveBeenCalledWith(
      "authorization-1",
    ),
  );
});

it("retains cleanup after confirmation refusal and refreshes the durable recovery state", async () => {
  const { view, controller } = revocationContext();
  controller.confirmRevocation.mockRejectedValue(
    new Error("Provider authorization is still pending."),
  );
  const onChanged = vi.fn();
  render(
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      onChanged={onChanged}
      onFlash={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I revoked this application at the provider",
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm provider revocation" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(
    await screen.findByRole("img", {
      name: "Provider authorization is still pending.",
    }),
  ).toBeTruthy();
  expect(view.recovery).toHaveLength(1);
  expect(nativeVerified(view)).toBe(false);
});

it("refuses confirmation while the driver's operation deadline is still live", async () => {
  const { view, controller } = revocationContext(false);
  render(
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  const statement = screen.getByRole("checkbox", {
    name: "I revoked this application at the provider",
  });
  expect(statement).toHaveProperty("disabled", true);
  await userEvent.click(statement);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm provider revocation" }),
  );
  expect(controller.confirmRevocation).not.toHaveBeenCalled();
  expect(
    screen.getByRole("img", {
      name: /This provider authorization requires recovery before confirmation/,
    }),
  ).toBeTruthy();
  expect(nativeVerified(view)).toBe(false);
});

it("does not offer attestation through an unsafe external settings URL", () => {
  const { view, controller } = revocationContext();
  controller.revocationInstructions.mockReturnValue({
    url: "https://user:private@example.com/apps",
    message: "Provider settings",
    canConfirm: true,
  });
  render(
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("link", {
      name: "Open provider revocation instructions",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Confirm provider revocation" }),
  ).toBeNull();
  expect(controller.confirmRevocation).not.toHaveBeenCalled();
});

it("waits for the MCP guide and confirms with the revision the user saw", async () => {
  const { view, controller: base } = revocationContext();
  view.configuration.method = "mcp";
  let resolveGuide: (guide: {
    url: string;
    message: string;
    canConfirm: boolean;
    revision: number;
  }) => void = () => {};
  const guide = new Promise<{
    url: string;
    message: string;
    canConfirm: boolean;
    revision: number;
  }>((resolve) => {
    resolveGuide = resolve;
  });
  const confirmRevocation = vi.fn(
    async (_id: string, _revision?: number) => view,
  );
  const controller: NativeConnectorController = {
    ...base,
    revocationInstructions: () => null,
    loadRevocationInstructions: () => guide,
    confirmRevocation,
  };
  render(
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("link", {
      name: "Open provider revocation instructions",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Confirm provider revocation" }),
  ).toBeNull();
  resolveGuide({
    url: "https://www.spotify.com/account/apps/",
    message: "Revoke this application before confirming.",
    canConfirm: true,
    revision: 37,
  });
  const statement = await screen.findByRole("checkbox", {
    name: "I revoked this application at the provider",
  });
  await userEvent.click(statement);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm provider revocation" }),
  );
  await waitFor(() =>
    expect(confirmRevocation).toHaveBeenCalledWith("authorization-1", 37),
  );
});

it("clears the acknowledgement after a stale MCP confirmation is refused", async () => {
  const { view, controller: base } = revocationContext();
  view.configuration.method = "mcp";
  let revision = 37;
  const confirmRevocation = vi.fn(async (_id: string, _revision?: number) => {
    revision = 38;
    throw new Error(
      "Provider authorization changed. Retry provider revocation.",
    );
  });
  const loadRevocationInstructions = vi.fn(async () => ({
    url: "https://www.spotify.com/account/apps/",
    message: "Revoke this application before confirming.",
    canConfirm: true,
    revision,
  }));
  const controller: NativeConnectorController = {
    ...base,
    revocationInstructions: () => null,
    loadRevocationInstructions,
    confirmRevocation,
  };
  render(
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  await userEvent.click(
    await screen.findByRole("checkbox", {
      name: "I revoked this application at the provider",
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm provider revocation" }),
  );
  await waitFor(() =>
    expect(confirmRevocation).toHaveBeenCalledWith("authorization-1", 37),
  );
  await waitFor(() =>
    expect(loadRevocationInstructions).toHaveBeenCalledTimes(2),
  );
  const freshStatement = await screen.findByRole("checkbox", {
    name: "I revoked this application at the provider",
  });
  expect(freshStatement).toHaveProperty("checked", false);
  expect(
    screen.getByRole("button", { name: "Confirm provider revocation" }),
  ).toHaveProperty("disabled", true);
  expect(view.recovery).toHaveLength(1);
});

it("loads one MCP guide under Strict Mode effect replay", async () => {
  const { view, controller: base } = revocationContext();
  view.configuration.method = "mcp";
  const load = vi.fn(async () => ({
    url: "https://www.spotify.com/account/apps/",
    message: "Revoke this application before confirming.",
    canConfirm: true,
    revision: 37,
  }));
  render(
    <StrictMode>
      <NativeConnectorRecovery
        view={view}
        controller={{
          ...base,
          revocationInstructions: () => null,
          loadRevocationInstructions: load,
        }}
        onChanged={vi.fn()}
        onFlash={vi.fn()}
      />
    </StrictMode>,
  );
  await screen.findByRole("checkbox", {
    name: "I revoked this application at the provider",
  });
  expect(load).toHaveBeenCalledTimes(1);
});
