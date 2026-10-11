/** @vitest-environment jsdom */
import { KEY_PATTERN } from "@opensesame/app-core/lib/model-keys/vocabulary.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ModelKeysPanel, modelKeyResource } from "./ModelKeysPanel.js";
import { fillSheet, mintKeyTestBed } from "./mint-key.test-support.js";

const bed = mintKeyTestBed();
const { ready } = bed;

it("draws nothing where a key cannot exist", async () => {
  const { container } = render(
    <ModelKeysPanel
      providerId="openai"
      providerName="OpenAI"
      connectionId="x"
    />,
  );
  expect(container.innerHTML).toBe("");
  expect(modelKeyResource("replicate")).toBeNull();
  expect(modelKeyResource("litellm")).toBeNull();
  expect(modelKeyResource("openai")).toBe("https://api.openai.com/v1");
});

it("is a head and one key to create one, until there is a key", async () => {
  await ready();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create a key" })).toBeTruthy();
  expect(screen.queryAllByTestId("model-key")).toHaveLength(0);
});

it("creates a key, shows it once, and lists it without it", async () => {
  const h = await ready();
  const { sheet, create } = await fillSheet("my-agent", "gpt-4o");
  expect(create()).toHaveProperty("disabled", false);
  await userEvent.click(create());

  const shown = await within(sheet).findByTestId("model-key-token");
  // The whole key is on the screen, as text that wraps, not clipped in a field.
  expect(shown.textContent).toMatch(KEY_PATTERN);
  expect(shown.getAttribute("aria-labelledby")).toBe("model-key-token-label");
  expect(
    within(sheet).getByLabelText("Shown once. Ends in 1 hour."),
  ).toBeTruthy();
  const token = shown.textContent ?? "";
  expect(h.broker.list()).toHaveLength(1);

  bed.afterTheGuard();
  await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const row = screen.getByTestId("model-key");
  expect(within(row).getByText("my-agent")).toBeTruthy();
  expect(within(row).getByLabelText("Active")).toBeTruthy();
  expect(row.textContent).toContain("gpt-4o");
  expect(row.textContent).toContain("25 requests left");
  // The key was on the screen once; it is nowhere on it now.
  expect(document.body.innerHTML).not.toContain(token);
  expect(document.body.innerHTML).not.toContain("osk_");
});

it("revokes a key and keeps the row as a record of it", async () => {
  const h = await ready();
  const { create } = await fillSheet("my-agent", "gpt-4o");
  await userEvent.click(create());
  const done = await screen.findByRole("button", { name: "Done" });
  bed.afterTheGuard();
  await userEvent.click(done);

  await userEvent.click(
    screen.getByRole("button", { name: "Revoke the key for my-agent" }),
  );
  await waitFor(() =>
    expect(within(screen.getByTestId("model-key")).getByLabelText("Revoked")),
  );
  expect(
    screen.queryByRole("button", { name: "Revoke the key for my-agent" }),
  ).toBeNull();
  expect(h.broker.list()[0]?.status).toBe("revoked");
});

it("says what is wrong with a name or a list of models before anything is asked", async () => {
  await ready();
  const { sheet, create } = await fillSheet(
    "not a name!",
    "gpt-4o, bad entry!",
  );
  expect(
    within(sheet).getByLabelText("Letters, digits and . _ : @ - only"),
  ).toBeTruthy();
  expect(
    within(sheet).getByLabelText("Model ids, namespace/*, or *"),
  ).toBeTruthy();
  expect(create()).toHaveProperty("disabled", true);
});

it("offers any model as a fill and sends what the fill says", async () => {
  const h = await ready();
  await userEvent.click(screen.getByRole("button", { name: "Create a key" }));
  const sheet = screen.getByRole("dialog", { name: "Create a key" });
  await userEvent.type(
    within(sheet).getByLabelText("App or agent"),
    "any-agent",
  );
  await userEvent.click(
    within(sheet).getByRole("button", { name: "Any model" }),
  );
  await userEvent.click(
    within(sheet).getByRole("button", { name: "Create a key" }),
  );
  await within(sheet).findByTestId("model-key-token");
  expect(h.broker.list()[0]?.models).toEqual(["model:openai/*"]);
});

it("tells a person who has not verified the provider's key what to do first", async () => {
  const h = await ready();
  h.connections.set("conn-openai", { providerId: "openai", verified: false });
  const { create } = await fillSheet("my-agent", "gpt-4o");
  await userEvent.click(create());
  const sheet = screen.getByRole("dialog", { name: "Create a key" });
  expect(
    await within(sheet).findByLabelText(
      "Verify this provider's key before creating one.",
    ),
  ).toBeTruthy();
  expect(h.broker.list()).toHaveLength(0);
});

it("closes with the sheet's one way out, and forgets a key it had shown", async () => {
  await ready();
  const { create } = await fillSheet("my-agent", "gpt-4o");
  await userEvent.click(create());
  await screen.findByTestId("model-key-token");
  const close = screen
    .getAllByRole("button", { name: "Close" })
    .find((button) => button.classList.contains("icon-btn"));
  if (!close) throw new Error("the sheet has no close key");
  await userEvent.click(close);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.innerHTML).not.toContain("osk_");
});
