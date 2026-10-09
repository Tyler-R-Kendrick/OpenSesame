/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

it("distinguishes validated access from returned account identity and provider-managed permissions", () => {
  const view = nativeUiView();
  render(
    <NativeConnectorSummary
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={nativeUiController(view)}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("img", { name: "Algolia access verified" }),
  ).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Algolia connected" })).toBeNull();
  expect(screen.getByText("Managed by the provider")).toBeTruthy();
  expect(screen.getByText("Products")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Authorize/ })).toBeNull();
  const verify = screen.getByRole("button", { name: "Verify Algolia access" });
  expect(verify).toHaveProperty("title", "Verify Algolia access");
  expect(verify.classList.contains("icon-btn")).toBe(true);
  expect(verify.textContent).toBe("");
});

it("refreshes the status immediately when an actual operation requires reauthorization", async () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  controller.invoke.mockImplementation(async () => {
    view.status = "reauthorize";
    view.grants[0].needsReauth = true;
    throw new Error("Algolia refused this authorization.");
  });
  const onChanged = vi.fn();
  render(
    <NativeConnectorSummary
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={controller}
      onChanged={onChanged}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByText("Read Algolia indexes", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Read Algolia indexes" }),
  );
  await waitFor(() =>
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reauthorize" }),
    ),
  );
  expect(controller.invoke).toHaveBeenCalledWith("indexes.list", {});
  expect(
    await screen.findByRole("img", {
      name: "Algolia refused this authorization.",
    }),
  ).toBeTruthy();
});

it("renders only typed summaries and provider-allowlisted safe result links", async () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  controller.invoke.mockResolvedValue({
    label: "Algolia indexes",
    items: [
      {
        id: "1",
        label: "<script>text only</script>",
        url: "https://dashboard.algolia.com/apps/app-1/indices/products",
      },
      {
        id: "2",
        label: "Other origin",
        url: "https://other.example.test/index",
      },
      {
        id: "3",
        label: "Credential URL",
        url: "https://user:password@dashboard.algolia.com/index",
      },
      { id: "4", label: "Unsafe protocol", url: "javascript:alert(1)" },
    ],
  });
  const rendered = render(
    <NativeConnectorSummary
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByText("Read Algolia indexes", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Read Algolia indexes" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "<script>text only</script>" }),
    ).toHaveProperty(
      "href",
      "https://dashboard.algolia.com/apps/app-1/indices/products",
    ),
  );
  expect(screen.queryByRole("link", { name: "Other origin" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Credential URL" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Unsafe protocol" })).toBeNull();
  expect(rendered.container.querySelector("script")).toBeNull();
});

it("requires provider cleanup before removal and keeps failures recoverable", async () => {
  const view = nativeUiView();
  const controller = nativeUiController(view);
  controller.remove.mockImplementation(async () => {
    view.status = "cleanup";
    view.recovery = [
      {
        id: "revoke-1",
        kind: "revoke",
        label: "Algolia key revocation",
        detail: "Retry provider cleanup before removing this connection.",
      },
    ];
    throw new Error("Provider cleanup could not finish.");
  });
  const onRemoved = vi.fn();
  const onChanged = vi.fn();
  render(
    <NativeConnectorSummary
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={controller}
      onChanged={onChanged}
      onFlash={vi.fn()}
      onRemoved={onRemoved}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Remove connector" }),
  );
  expect(controller.remove).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm remove connector" }),
  );
  await waitFor(() =>
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cleanup" }),
    ),
  );
  expect(onRemoved).not.toHaveBeenCalled();
  expect(
    await screen.findByRole("img", {
      name: "Provider cleanup could not finish.",
    }),
  ).toBeTruthy();
});

it("does not advertise completion or permit use for an unverified record", () => {
  const view = nativeUiView();
  view.verifiedAt = null;
  render(
    <NativeConnectorSummary
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={nativeUiController(view)}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("img", { name: "Algolia access verified" }),
  ).toBeNull();
  expect(
    screen.getByRole("img", { name: "Provider verification pending" }),
  ).toBeTruthy();
  expect(screen.queryByText("Verified")).toBeNull();
  expect(screen.getByText("Verification pending")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Read Algolia indexes" }),
  ).toHaveProperty("disabled", true);
});

it("uses provider-owned actors and displays granted scopes rather than selected scopes", async () => {
  const view = nativeUiView();
  view.status = "reauthorize";
  view.configuration.method = "oauth";
  view.configuration.requestedScopes = {
    bot: ["chat:write", "channels:history"],
  };
  view.grants = [
    {
      actor: "bot",
      label: "Slack bot",
      permissionState: "known",
      grantedScopes: ["channels:history"],
      expiresAt: null,
      needsReauth: true,
    },
  ];
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      id: "oauth",
      label: "Public OAuth",
      available: true,
      fields: [],
      scopeGroups: [
        { actor: "bot", label: "Slack bot permissions", choices: [] },
      ],
    },
  ];
  const controller = nativeUiController(view);
  render(
    <NativeConnectorSummary
      descriptor={descriptor}
      view={view}
      controller={controller}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  expect(screen.getByText("channels:history")).toBeTruthy();
  expect(screen.queryByText("chat:write")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Authorize Slack bot permissions" }),
  );
  await waitFor(() => expect(controller.authorize).toHaveBeenCalledWith("bot"));
});

it("reports a missing expiry as unknown without inferring an unlimited token lifetime", () => {
  const view = nativeUiView();
  const result = render(
    <NativeConnectorSummary
      descriptor={nativeUiDescriptor()}
      view={view}
      controller={nativeUiController(view)}
      onChanged={vi.fn()}
      onFlash={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  expect(screen.getByText("Not reported by the provider")).toBeTruthy();
  expect(result.container.textContent).not.toMatch(
    /never expires|long-lived|renews itself/i,
  );
});
