import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import {
  TOKEN,
  vertexFixture,
} from "@opensesame/app-core/lib/ai-connections/vertex-http.test-support.js";
/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  gcpKeyFile,
  installGcpKey,
} from "@opensesame/app-core/lib/native-gcp.test-support.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AiConnectionPanels } from "./AiConnectionPanels.js";
installGcpKey();
afterEach(cleanup);
const button = (name: string) => screen.getByRole("button", { name });
async function prepare(providerId = "google-vertex") {
  const vault = await runtimeFixture();
  const http = await vertexFixture();
  const release = bindAiConnectionTransport(http.port);
  const onFlash = vi.fn();
  const rendered = render(
    <AiConnectionPanels providerId={providerId} onFlash={onFlash} />,
  );
  return {
    vault,
    http,
    onFlash,
    async close() {
      rendered.unmount();
      release();
      await http.close();
      await vault.close();
    },
  };
}
async function enter(label: string, value: string) {
  const field = screen.getByLabelText(label, { exact: true });
  await userEvent.clear(field);
  await userEvent.type(field, value);
}
async function serviceAccount() {
  const user = userEvent.setup();
  await user.click(
    screen.getByLabelText("Service account JSON", { exact: true }),
  );
  await user.paste(gcpKeyFile());
}
async function populated() {
  await enter("Google Cloud project", "my-project-123");
  await enter("Model ID", "gemini-2.5-flash");
}
async function saved() {
  await userEvent.click(button("Save AI connection"));
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  const id = readDeviceRows()[0]?.connectionId;
  if (!id) throw new Error("Actual saved record required");
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Model inference" }),
    ).toBeTruthy(),
  );
  return id;
}
it("configures native Vertex using real shared form, real signed token/inference, write-only custody and finite workspace", async () => {
  const run = await prepare();
  try {
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Vertex API base URL")).toHaveProperty(
      "readOnly",
      true,
    );
    await populated();
    await serviceAccount();
    await userEvent.click(button("Test AI connection"));
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Model inference verified" }),
      ).toBeTruthy(),
    );
    expect(readDeviceRows()).toEqual([]);
    const id = await saved();
    expect(readAiConnection(id)?.vertex).toEqual({
      project: "my-project-123",
      location: "us-central1",
      credential: "service-account",
    });
    expect(screen.getByLabelText("Service account JSON")).toHaveProperty(
      "value",
      "",
    );
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    await enter("Prompt", "Real selected UI question.");
    await userEvent.click(button("Send prompt"));
    await waitFor(() =>
      expect(screen.getByLabelText("Model answer").textContent).toBe(
        "Exact Vertex answer.",
      ),
    );
    expect(
      run.http.records.filter((row) => row.path.endsWith(":generateContent")),
    ).toHaveLength(3);
    expect(run.http.records.at(-1)?.body).toContain(
      "Real selected UI question.",
    );
    expect([...run.vault.files.values()].join(" ")).not.toContain(
      JSON.parse(gcpKeyFile()).private_key,
    );
    const before = run.http.records.length;
    await enter("Google Cloud project", "other-project-123");
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    expect(
      screen.queryByRole("img", { name: "Model inference verified" }),
    ).toBeNull();
    expect(run.http.records).toHaveLength(before);
  } finally {
    await run.close();
  }
});
it("composes BYO Vertex bearer configuration, custom mount, model request and clears mode-bound secret", async () => {
  const run = await prepare("byo-ai");
  try {
    await userEvent.selectOptions(
      screen.getByLabelText("API family"),
      "gemini_generate_content",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Endpoint type"),
      "vertex",
    );
    await populated();
    await enter("Vertex API base URL", "http://localhost:41999/custom/vertex");
    await userEvent.selectOptions(
      screen.getByLabelText("Vertex authentication"),
      "access-token",
    );
    await enter("Google access token", TOKEN);
    const id = await saved();
    expect(readAiConnection(id)?.vertex?.credential).toBe("access-token");
    expect(screen.getByLabelText("Google access token")).toHaveProperty(
      "value",
      "",
    );
    expect(run.http.records[0]?.path).toBe(
      "/custom/vertex/projects/my-project-123/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
    );
    expect(run.http.records.some((row) => row.path === "/token")).toBe(false);
    await enter("Prompt", "BYO selected UI question.");
    await userEvent.click(button("Send prompt"));
    await waitFor(() =>
      expect(screen.getByLabelText("Model answer").textContent).toBe(
        "Exact Vertex answer.",
      ),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Vertex authentication"),
      "service-account",
    );
    expect(screen.getByLabelText("Service account JSON")).toHaveProperty(
      "value",
      "",
    );
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    await userEvent.selectOptions(
      screen.getByLabelText("API family"),
      "anthropic_messages",
    );
    expect(screen.queryByLabelText("Vertex authentication")).toBeNull();
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    await userEvent.selectOptions(
      screen.getByLabelText("API family"),
      "gemini_generate_content",
    );
    expect(screen.getByLabelText("Endpoint type")).toHaveProperty(
      "value",
      "standard",
    );
    expect(screen.queryByLabelText("Service account JSON")).toBeNull();
  } finally {
    await run.close();
  }
});
it("updates native derived endpoint from location and requires new secret before target replay", async () => {
  const run = await prepare();
  try {
    await populated();
    await serviceAccount();
    await userEvent.selectOptions(
      screen.getByLabelText("Vertex authentication"),
      "access-token",
    );
    expect(screen.getByLabelText("Google access token")).toHaveProperty(
      "value",
      "",
    );
    await enter("Google access token", TOKEN);
    await enter("Vertex location", "global");
    expect(screen.getByLabelText("Vertex API base URL")).toHaveProperty(
      "value",
      "https://aiplatform.googleapis.com/v1",
    );
    expect(screen.getByLabelText("Google access token")).toHaveProperty(
      "value",
      "",
    );
    expect(button("Test AI connection")).toHaveProperty("disabled", true);
    expect(run.http.records).toEqual([]);
    await enter("Google access token", TOKEN);
    await saved();
    expect(run.http.records[0]?.path).toContain("/locations/global/");
  } finally {
    await run.close();
  }
});
