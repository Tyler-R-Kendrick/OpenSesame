/** @vitest-environment jsdom */
import { REPLICATE_TOKEN } from "@opensesame/app-core/lib/ai-connections/replicate-tls.test-support.js";
import { deleteAiConnection } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  button,
  clickTerminal,
  cold,
  draw,
  field,
  heldClosed,
  operation,
  save,
  setup,
  storedDraft,
  verification,
} from "./replicate-ui.test-support.js";

it.each(["replicate", "byo-ai"])(
  "reaches the full %s Settings form, performs explicit Test/Save and cold-selected finite inference over actual TLS",
  async (provider) => {
    const f = await setup(provider);
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(
      screen.getByRole("form", { name: "AI connection configuration" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save configuration" }),
    ).toBeNull();
    expect(
      screen.queryByText(/not supported|cannot connect|no browser connection/i),
    ).toBeNull();
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    field("Prediction verification input JSON", "[]");
    expect(button("Test AI connection")).toHaveProperty("disabled", true);
    field("Prediction verification input JSON", JSON.stringify(verification));
    await clickTerminal(f, "Test AI connection");
    await screen.findByLabelText("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    const id = await save(f);
    expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
      "value",
      "",
    );
    expect(
      screen.getByLabelText("Prediction verification input JSON"),
    ).toHaveProperty("value", "");
    expect(storedDraft(id)).toMatchObject({
      family: "replicate_predictions",
      apiKey: "",
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      verification.subject,
    );
    expect([...f.vault.files.values()].join(" ")).not.toContain(
      REPLICATE_TOKEN,
    );
    expect([...f.vault.files.values()].join(" ")).not.toContain(
      verification.subject,
    );
    cleanup();
    await act(cold);
    draw(provider, id);
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    field("Prediction input JSON", JSON.stringify(operation));
    await clickTerminal(f, "Run prediction");
    await waitFor(() =>
      expect(screen.getByLabelText("Prediction output").textContent).toContain(
        "Independently produced prediction.",
      ),
    );
    expect(screen.queryByRole("link", { name: /untrusted/ })).toBeNull();
    expect(JSON.parse(f.http.requests.at(-2)?.body ?? "")).toEqual({
      input: operation,
    });
    expect(f.http.requests.map((row) => row.method)).toEqual([
      "POST",
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
    ]);
  },
);
it("clears model-specific transient verification and write-only token on target edits and actual vault lock", async () => {
  const f = await setup("byo-ai");
  field("Prediction verification input JSON", JSON.stringify(verification));
  field("Model ID", "other/model");
  expect(
    screen.getByLabelText("Prediction verification input JSON"),
  ).toHaveProperty("value", "");
  expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
    "value",
    "",
  );
  field("API key", REPLICATE_TOKEN);
  field("Prediction verification input JSON", JSON.stringify(verification));
  await act(async () => vaultStore.lock());
  expect(
    screen.getByLabelText("Prediction verification input JSON"),
  ).toHaveProperty("value", "");
  expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
    "value",
    "",
  );
  await f.user.selectOptions(
    screen.getByLabelText("API family"),
    "openai_chat",
  );
  expect(
    screen.queryByLabelText("Prediction verification input JSON"),
  ).toBeNull();
  expect(f.http.requests).toEqual([]);
});
it.each(["Test AI connection", "Save AI connection"])(
  "makes the shared %s Cancel control request the exact remote prediction cancellation without saving a record",
  async (label) => {
    const f = await setup();
    f.http.state.mode = "held";
    field("Prediction verification input JSON", JSON.stringify(verification));
    await f.user.click(button(label));
    await f.http.held;
    await f.user.click(button("Cancel prediction"));
    await screen.findByLabelText("Prediction cancellation requested.");
    await heldClosed(f);
    expect(f.http.requests.map((row) => row.path)).toEqual([
      "/v1/models/owner/model/predictions",
      "/v1/predictions/owned-1",
      "/v1/predictions/owned-1/cancel",
    ]);
    expect(readDeviceRows()).toEqual([]);
    expect(button(label)).toHaveProperty("disabled", false);
    expect(
      screen.queryByLabelText("AI connection verified and saved in this vault"),
    ).toBeNull();
  },
);
it("uses the saved workspace Cancel control without producing prediction output", async () => {
  const f = await setup();
  await save(f);
  f.http.state.mode = "held";
  field("Prediction input JSON", JSON.stringify(operation));
  await f.user.click(button("Run prediction"));
  await f.http.held;
  await f.user.click(button("Cancel prediction"));
  await screen.findByLabelText("Prediction cancellation requested.");
  await heldClosed(f);
  expect(f.http.requests.at(-1)?.path).toBe("/v1/predictions/owned-2/cancel");
  expect(screen.getByLabelText("Prediction output").textContent).toBe("");
  expect(button("Run prediction")).toHaveProperty("disabled", false);
});
it.each(["lock", "unmount", "route"])(
  "ends held form HTTP on actual %s without sending an authenticated cancellation or publishing a late mark",
  async (withdrawal) => {
    const f = await setup();
    f.http.state.mode = "held";
    field("Prediction verification input JSON", JSON.stringify(verification));
    await f.user.click(button("Save AI connection"));
    await f.http.held;
    await act(async () => {
      if (withdrawal === "lock") vaultStore.lock();
      else if (withdrawal === "unmount") f.mounted.unmount();
      else await f.mounted.navigate("byo-ai");
    });
    await heldClosed(f);
    expect(f.http.requests).toHaveLength(2);
    expect(readDeviceRows()).toEqual([]);
    expect(
      screen.queryByLabelText("Prediction cancellation requested."),
    ).toBeNull();
    expect(
      screen.queryByLabelText("AI connection verified and saved in this vault"),
    ).toBeNull();
  },
);
it.each(["lock", "unmount", "record"])(
  "withdraws held saved inference on actual %s without authenticated cancel, stale failure or late output",
  async (withdrawal) => {
    const f = await setup();
    const id = await save(f);
    f.http.state.mode = "held";
    field("Prediction input JSON", JSON.stringify(operation));
    await f.user.click(button("Run prediction"));
    await f.http.held;
    await act(async () => {
      if (withdrawal === "lock") vaultStore.lock();
      else if (withdrawal === "unmount") f.mounted.unmount();
      else await deleteAiConnection(id);
    });
    await heldClosed(f);
    expect(f.http.requests).toHaveLength(4);
    expect(f.http.requests.some((row) => row.path.endsWith("/cancel"))).toBe(
      false,
    );
    expect(
      screen.queryByLabelText("Prediction cancellation requested."),
    ).toBeNull();
    expect(
      screen.queryByLabelText("Prediction output")?.textContent ?? "",
    ).toBe("");
  },
);
async function failedAttempt(
  f: Awaited<ReturnType<typeof setup>>,
  label: string,
  mode: string,
) {
  if (["empty", "wrong-id"].includes(mode)) await clickTerminal(f, label);
  else await f.user.click(button(label));
  await waitFor(() => expect(button(label)).toHaveProperty("disabled", false));
}
it.each(["unauthorized", "forbidden", "empty", "wrong-id"])(
  "preserves actual %s Test/Save failure through the full Settings shared form and never falls back to ambient fetch",
  async (mode) => {
    const f = await setup();
    const ambient = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No ambient fallback"));
    f.http.state.mode = mode;
    field("Prediction verification input JSON", JSON.stringify(verification));
    await failedAttempt(f, "Test AI connection", mode);
    expect(screen.queryByLabelText("Model inference verified")).toBeNull();
    await failedAttempt(f, "Save AI connection", mode);
    expect(readDeviceRows()).toEqual([]);
    expect(ambient).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(REPLICATE_TOKEN);
  },
);
