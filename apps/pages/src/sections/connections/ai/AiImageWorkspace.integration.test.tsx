/** @vitest-environment jsdom */
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import {
  coldSavedImageVault,
  savedImageFixture,
} from "@opensesame/app-core/lib/ai-connections/saved-image.test-support.js";
import {
  STABILITY_KEY,
  STABILITY_PROMPT,
} from "@opensesame/app-core/lib/ai-connections/stability-tls.test-support.js";
import {
  aiConnectionRecord,
  commitAiConnection,
  readAiConnection,
  savedAiConnections,
} from "@opensesame/app-core/lib/ai-connections/store.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AiConnectionPanels } from "./AiConnectionPanels.js";
import { AiInferenceWorkspace } from "./AiInferenceWorkspace.js";
import { previewHost } from "./image-preview.test-support.js";

const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
}
function button(name: string) {
  return screen.getByRole("button", { name });
}
async function setup(provider: "stability" | "byo-ai" = "stability") {
  const form = await new Response("x=y", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData();
  vi.stubGlobal("FormData", form.constructor);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
  const f = await savedImageFixture(provider);
  closes.push(f.close);
  const host = previewHost();
  closes.push(host.close);
  return { ...f, host };
}
async function workspace() {
  const f = await setup();
  const saved = await f.save();
  const view = render(
    <AiInferenceWorkspace connectionId={saved.connectionId} />,
  );
  field("Image prompt", STABILITY_PROMPT);
  return { ...f, saved, view };
}
type Fixture = Awaited<ReturnType<typeof workspace>>;
async function withdraw(f: Fixture, kind: string) {
  if (kind === "unmount") f.view.unmount();
  else if (kind === "cancel")
    fireEvent.click(button("Cancel image generation"));
  else if (kind === "prompt") field("Image prompt", "Replacement prompt");
  else if (kind === "route") f.http.withdraw();
  else if (kind === "feature") f.withdrawFeature();
  else if (kind === "vault") vaultStore.lock();
  else if (kind === "credential") {
    const token = vaultStore
      .getSnapshot()
      .items.find((item) => item.kind === "credential");
    if (!token || token.kind !== "credential" || token.method.type !== "token")
      throw new Error("Expected saved token");
    await vaultStore.saveItem({
      ...token,
      method: { ...token.method, token: "changed-image-token" },
    });
  } else {
    const record = aiConnectionRecord(f.saved.connectionId);
    const draft = readAiConnection(f.saved.connectionId);
    if (!record || !draft) throw new Error("Expected saved row");
    await commitAiConnection(
      { ...draft, name: "Replaced image row" },
      vaultStore.getSnapshot().tomb,
      "",
      () => {},
      record,
    );
  }
}
it.each(["stability", "byo-ai"] as const)(
  "exposes the actual %s form and consumes Test/Save, cold restore, then independently owned local preview/download",
  async (provider) => {
    const f = await setup(provider);
    const onFlash = vi.fn();
    render(<AiConnectionPanels providerId={provider} onFlash={onFlash} />);
    if (provider === "byo-ai") {
      field("API family", "stability_sd3");
      field("API base URL", f.draft.baseUrl);
      field("Model ID", f.draft.model);
    } else {
      expect(screen.getByLabelText("Model ID")).toHaveProperty(
        "value",
        "sd3.5-medium",
      );
      expect(screen.getByLabelText("API base URL")).toHaveProperty(
        "value",
        f.draft.baseUrl,
      );
    }
    field("API key", STABILITY_KEY);
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    field("Verification image prompt", STABILITY_PROMPT);
    fireEvent.click(button("Test AI connection"));
    await screen.findByLabelText("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    fireEvent.click(button("Save AI connection"));
    await waitFor(() => expect(savedAiConnections()).toHaveLength(1));
    await waitFor(() =>
      expect(button("Save AI connection")).toHaveProperty("disabled", true),
    );
    const saved = savedAiConnections()[0];
    if (!saved) throw new Error("Real saved configuration missing");
    expect(saved.draft).toMatchObject({
      family: "stability_sd3",
      apiKey: "",
      model: f.draft.model,
    });
    expect(screen.getByLabelText("Verification image prompt")).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
      "value",
      "",
    );
    cleanup();
    await act(coldSavedImageVault);
    const view = render(
      <AiConnectionPanels
        providerId={provider}
        connectionId={saved.view.connectionId}
        onFlash={onFlash}
      />,
    );
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    expect(screen.queryByLabelText("Model answer")).toBeNull();
    field("Image prompt", STABILITY_PROMPT);
    fireEvent.click(button("Generate image"));
    await waitFor(() => expect(f.host.pending).toHaveLength(1));
    // Generic action retirement has already occurred before local decode completes.
    await waitFor(() =>
      expect(button("Generate image")).toHaveProperty("disabled", false),
    );
    expect(f.host.revoked).toEqual([]);
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
    await act(async () => f.host.pending[0].resolve());
    expect(
      screen
        .getByRole("img", { name: "Generated artwork" })
        .getAttribute("src"),
    ).toBe("blob:owned-image-1");
    const captures = f.captures();
    fireEvent.click(button("Download image"));
    expect(f.host.clicked).toEqual([
      { href: "blob:owned-image-1", filename: "generated-image.png" },
    ]);
    expect(f.host.urls[0].type).toBe("image/png");
    expect(f.captures()).toBe(captures);
    expect(f.http.records).toHaveLength(3);
    expect(onFlash).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(STABILITY_KEY);
    for (const secret of [STABILITY_KEY, STABILITY_PROMPT]) {
      expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
      expect([...f.vault.files.values()].join(" ")).not.toContain(secret);
    }
    view.unmount();
    expect(f.host.revoked).toEqual(["blob:owned-image-1"]);
  },
);
it.each([
  "cancel",
  "unmount",
  "row",
  "credential",
  "route",
  "feature",
  "vault",
])(
  "actual %s ends held image generation within2s and never publishes late output",
  async (kind) => {
    const f = await workspace();
    f.http.state.mode = "hold-body";
    fireEvent.click(button("Generate image"));
    await waitFor(() => expect(f.http.state.held).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(f.http.records.at(-1)?.closed).toBe(false);
    const start = performance.now();
    await act(() => withdraw(f, kind));
    await waitFor(() => expect(f.http.records.at(-1)?.closed).toBe(true), {
      timeout: 1500,
    });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(f.host.pending).toEqual([]);
    expect(f.host.clicked).toEqual([]);
    expect(f.http.records).toHaveLength(2);
  },
);
it.each([
  "unmount",
  "prompt",
  "row",
  "credential",
  "route",
  "feature",
  "vault",
])(
  "original %s revokes pending decode; a late decoder cannot publish or download",
  async (kind) => {
    const f = await workspace();
    fireEvent.click(button("Generate image"));
    await waitFor(() => expect(f.host.pending).toHaveLength(1));
    await waitFor(() =>
      expect(button("Generate image")).toHaveProperty("disabled", false),
    );
    await act(() => withdraw(f, kind));
    await waitFor(() => expect(f.host.revoked).toEqual(["blob:owned-image-1"]));
    await act(async () => f.host.pending[0].resolve());
    expect(screen.queryByRole("img", { name: "Generated artwork" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
    expect(f.host.clicked).toEqual([]);
  },
);
it("replaces a completed image and releases both URLs on actual unmount without recapturing during download", async () => {
  const f = await workspace();
  fireEvent.click(button("Generate image"));
  await waitFor(() => expect(f.host.pending).toHaveLength(1));
  await act(async () => f.host.pending[0].resolve());
  await waitFor(() =>
    expect(button("Generate image")).toHaveProperty("disabled", false),
  );
  fireEvent.click(button("Generate image"));
  await waitFor(() => expect(f.host.pending).toHaveLength(2));
  expect(f.host.revoked).toEqual(["blob:owned-image-1"]);
  await act(async () => f.host.pending[1].resolve());
  fireEvent.click(button("Download image"));
  expect(f.host.clicked).toEqual([
    { href: "blob:owned-image-2", filename: "generated-image.png" },
  ]);
  f.view.unmount();
  expect(f.host.revoked).toEqual(["blob:owned-image-1", "blob:owned-image-2"]);
  expect(f.captures()).toBe(3);
});

it.each([
  "unmount",
  "prompt",
  "row",
  "credential",
  "route",
  "feature",
  "vault",
])(
  "original %s revokes already-ready pixels and prevents use of the old download button",
  async (kind) => {
    const f = await workspace();
    fireEvent.click(button("Generate image"));
    await waitFor(() => expect(f.host.pending).toHaveLength(1));
    await act(async () => f.host.pending[0].resolve());
    await waitFor(() =>
      expect(button("Generate image")).toHaveProperty("disabled", false),
    );
    const oldDownload = button("Download image");
    await act(() => withdraw(f, kind));
    await waitFor(() => expect(f.host.revoked).toEqual(["blob:owned-image-1"]));
    fireEvent.click(oldDownload);
    expect(f.host.clicked).toEqual([]);
    expect(screen.queryByRole("img", { name: "Generated artwork" })).toBeNull();
  },
);
it("keeps an actual provider failure visible without exposing or retaining any pixels", async () => {
  const f = await workspace();
  f.http.state.mode = "filtered";
  fireEvent.click(button("Generate image"));
  await screen.findByRole("img", {
    name: "The image service filtered this generation. Change the prompt before trying again.",
  });
  expect(button("Generate image")).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Image prompt")).toHaveProperty(
    "value",
    STABILITY_PROMPT,
  );
  expect(f.host.pending).toEqual([]);
  expect(f.host.clicked).toEqual([]);
  expect(document.body.textContent).not.toContain(STABILITY_KEY);
});
