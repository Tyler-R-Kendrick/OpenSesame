/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorRecovery } from "./NativeConnectorRecovery.js";
import {
  nativeUiController,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

it("keeps cleanup visible on retry failure and reflects the durable result after retry", async () => {
  const view = nativeUiView();
  view.status = "cleanup";
  view.recovery = [
    {
      id: "revoke-1",
      kind: "revoke",
      label: "Algolia key revocation",
      detail: "Retry provider cleanup before removing this connection.",
    },
  ];
  const controller = nativeUiController(view);
  controller.retry.mockRejectedValueOnce(new Error("Provider unavailable."));
  controller.retry.mockImplementationOnce(async () => {
    view.recovery = [];
    view.status = "configuration";
    return view;
  });
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
    screen.getByRole("button", { name: "Retry algolia key revocation" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(
    await screen.findByRole("img", { name: "Provider unavailable." }),
  ).toBeTruthy();
  expect(view.recovery).toHaveLength(1);
  await userEvent.click(
    screen.getByRole("button", { name: "Retry algolia key revocation" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  expect(controller.retry).toHaveBeenLastCalledWith("revoke-1");
  expect(onChanged).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "configuration", recovery: [] }),
  );
});
