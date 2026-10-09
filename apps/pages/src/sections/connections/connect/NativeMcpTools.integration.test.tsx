import { listNotices } from "@opensesame/app-core/lib/notices.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { z } from "zod";
import { useFlashNotice } from "../useFlashNotice.js";
import { NativeMcpTools } from "./NativeMcpTools.js";
import { installConnectorIntegration } from "./native-connector-integration.test-support.js";
import {
  advertisedArguments,
  nativeMcpToolsFixture,
} from "./native-mcp-tools.test-support.js";

installConnectorIntegration();

function ActualMcpPanel({
  actual,
}: { actual: Awaited<ReturnType<typeof nativeMcpToolsFixture>> }) {
  const [view, setView] = useState(actual.view);
  const [flash, setFlash] = useState<Flash | null>(null);
  useFlashNotice(flash, view.connectionId, "Adobe");
  return (
    <NativeMcpTools
      view={view}
      controller={actual.controller}
      onChanged={(next) => {
        if (next) setView(next);
      }}
      onFlash={setFlash}
    />
  );
}

it("shows actual required and nested argument rules before sending a provider tool call", async () => {
  const actual = await nativeMcpToolsFixture();
  render(<ActualMcpPanel actual={actual} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Discover MCP tools" }),
  );
  const action = "provider.search: Search published provider records";
  await userEvent.click(
    await screen.findByText(action, { selector: "summary" }),
  );
  expect(screen.getByText("query, filter")).toBeTruthy();
  const guidance = screen.getByLabelText("Advertised argument schema");
  expect(JSON.parse(guidance.textContent ?? "null")).toEqual(
    advertisedArguments,
  );
  expect(guidance.textContent).toContain('"published"');
  expect(guidance.textContent).toContain('"boolean"');
  expect(actual.methods).not.toContain("tools/call");
  await userEvent.click(
    screen.getByText("Advertised argument schema", { selector: "summary" }),
  );
  expect(guidance.closest("details")).toHaveProperty("open", true);
  await userEvent.click(screen.getByRole("button", { name: action }));
  const message =
    "Enter arguments that match this tool’s advertised input schema.";
  expect(await screen.findByRole("img", { name: message })).toBeTruthy();
  await waitFor(() =>
    expect(listNotices()).toContainEqual(
      expect.objectContaining({
        id: `connector:${actual.view.connectionId}`,
        tone: "err",
        body: message,
      }),
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(actual.methods).not.toContain("tools/call");
  const argumentsValue = { query: "design", filter: { published: true } };
  fireEvent.change(screen.getByLabelText("Tool arguments (JSON object)"), {
    target: { value: JSON.stringify(argumentsValue) },
  });
  await userEvent.click(screen.getByRole("button", { name: action }));
  await waitFor(() =>
    expect(screen.getByText("Actual provider tool result")).toBeTruthy(),
  );
  expect(
    actual.methods.filter((method) => method === "tools/call"),
  ).toHaveLength(1);
  const ToolCall = z.object({
    method: z.literal("tools/call"),
    params: z.object({
      name: z.literal("provider.search"),
      arguments: z.object({
        query: z.string(),
        filter: z.object({ published: z.boolean() }),
      }),
    }),
  });
  const calls = [];
  for (const request of actual.fixture.requests) {
    if (request.method !== "POST" || !request.url.endsWith("/mcp")) continue;
    const call = ToolCall.safeParse(JSON.parse(await request.text()));
    if (call.success) calls.push(call.data);
  }
  expect(calls[0]?.params.arguments).toEqual(argumentsValue);
});
