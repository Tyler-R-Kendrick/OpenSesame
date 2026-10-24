/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorActions } from "./NativeConnectorActions.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";
import { nativeKeyActions } from "./native-key-descriptor.js";

afterEach(cleanup);
it("opens only a compiled public handoff origin through the existing action output UI", async () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  controller.invoke.mockResolvedValue({
    label: "Public handoff prepared",
    items: [
      {
        id: "save",
        label: "Open issuer",
        url: "https://pay.google.com/gp/v/save/public-signed-fixture",
      },
      {
        id: "foreign",
        label: "Foreign result",
        url: "https://foreign.example.test/",
      },
    ],
  });
  const descriptor = nativeUiDescriptor();
  descriptor.actions = nativeKeyActions({
    name: "Issuer",
    methodLabel: "Key",
    instructions: "",
    fields: [],
    links: [],
    disconnectExplanation: "Local only",
    actions: [
      {
        id: "provider.pass.prepare",
        label: "Prepare public handoff",
        fields: [],
        resultOrigins: ["https://pay.google.com"],
      },
    ],
  });
  const ui = render(
    <NativeConnectorActions
      descriptor={descriptor}
      controller={controller}
      view={view}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByText("Prepare public handoff", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Prepare public handoff" }),
  );
  const link = await screen.findByRole("link", { name: "Open issuer" });
  expect(link).toHaveProperty("target", "_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(screen.queryByRole("link", { name: "Foreign result" })).toBeNull();
  const clicked = vi.fn((event: Event) => event.preventDefault());
  link.addEventListener("click", clicked);
  expect(clicked).not.toHaveBeenCalled();
  await userEvent.click(link);
  expect(clicked).toHaveBeenCalledOnce();
  ui.rerender(
    <NativeConnectorActions
      descriptor={descriptor}
      controller={controller}
      view={{ ...view, revision: 2 }}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
    />,
  );
  expect(screen.queryByRole("link", { name: "Open issuer" })).toBeNull();
});
it("keeps the existing no-link default for native key actions without a compiled handoff origin", () => {
  const actions = nativeKeyActions({
    name: "Issuer",
    methodLabel: "Key",
    instructions: "",
    fields: [],
    links: [],
    disconnectExplanation: "Local only",
    actions: [{ id: "read", label: "Read", fields: [] }],
  });
  expect(actions[0]?.resultOrigins).toEqual([]);
});
