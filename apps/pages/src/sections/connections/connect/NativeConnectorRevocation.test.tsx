/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorRecovery } from "./NativeConnectorRecovery.js";
import { nativeVerified } from "./native-connector-ui-values.js";
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
      name: /A provider authorization operation is still pending/,
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
