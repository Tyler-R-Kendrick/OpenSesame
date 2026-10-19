/** @vitest-environment jsdom */
import { MAX_AI_AUDIO_INPUT_BYTES } from "@opensesame/app-core/lib/ai-connections/media.js";
import {
  SCRIBE_TEXT,
  SCRIBE_TOKEN,
} from "@opensesame/app-core/lib/ai-connections/speech-tls.test-support.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  audioFile,
  button,
  cold,
  draw,
  field,
  heldClosed,
  sample,
  save,
  setup,
  storedDraft,
} from "./scribe-ui.test-support.js";

it.each(["elevenlabs", "byo-ai"])(
  "full %s Settings Test/Save/cold workspace consumes actual multipart transcripts with sealed custody",
  async (provider) => {
    const f = await setup(provider);
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(screen.getByLabelText("API family")).toHaveProperty(
      "value",
      "elevenlabs_scribe",
    );
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(
      screen.queryByLabelText("Authentication", { exact: true }),
    ).toBeNull();
    expect(
      screen.queryByText(/cannot connect|not supported|no browser connection/i),
    ).toBeNull();
    expect(button("Test AI connection")).toHaveProperty("disabled", true);
    await sample(f);
    await f.user.click(button("Test AI connection"));
    await screen.findByLabelText("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    const id = await save(f);
    expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByLabelText("Verification audio")).toHaveProperty(
      "value",
      "",
    );
    expect(storedDraft(id)).toMatchObject({
      family: "elevenlabs_scribe",
      apiKey: "",
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain(SCRIBE_TOKEN);
    expect([...f.vault.files.values()].join(" ")).not.toContain(SCRIBE_TOKEN);
    expect(JSON.stringify(readDeviceRows())).not.toContain("owned.wav");
    cleanup();
    await act(cold);
    draw(provider, id);
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    await sample(f, "Audio to transcribe", audioFile("operation.wav"));
    await f.user.click(button("Transcribe audio"));
    await waitFor(() =>
      expect(screen.getByLabelText("Transcript").textContent).toBe(SCRIBE_TEXT),
    );
    expect(f.http.records).toHaveLength(3);
    expect(
      f.http.records.every(
        (row) =>
          row.authenticated &&
          row.method === "POST" &&
          row.model === "scribe_v2" &&
          row.key === SCRIBE_TOKEN,
      ),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: /untrusted/ })).toBeNull();
  },
);
it.each(["unauthorized", "forbidden", "malformed", "echo"])(
  "failed %s transcription never saves or exposes credential material; selecting a new file clears stale failure",
  async (mode) => {
    const f = await setup();
    f.http.state.mode = mode;
    await sample(f);
    await f.user.click(button("Save AI connection"));
    await screen.findByLabelText(
      mode === "unauthorized" || mode === "forbidden"
        ? "The AI service refused the credential or its permissions."
        : mode === "malformed"
          ? "The AI service returned an unreadable JSON response."
          : "The transcription service returned an invalid or unsafe transcript.",
    );
    expect(button("Save AI connection")).toHaveProperty("disabled", false);
    expect(
      screen.queryByRole("region", { name: "Model inference" }),
    ).toBeNull();
    expect(readDeviceRows()).toEqual([]);
    expect(screen.getByRole("form").textContent).not.toContain(SCRIBE_TOKEN);
    f.http.state.mode = "complete";
    await sample(f, "Verification audio", audioFile("replacement.wav"));
    expect(
      screen.queryByLabelText(
        /refused the credential|invalid or unsafe|unreadable JSON/,
      ),
    ).toBeNull();
    await waitFor(() =>
      expect(
        listNotices().some(
          (notice) => notice.id === "ai-connection-elevenlabs",
        ),
      ).toBe(false),
    );
    await f.user.click(button("Test AI connection"));
    await screen.findByLabelText("Model inference verified");
  },
);
it.each(["empty", "oversized", "wrong magic", "wrong MIME"])(
  "rejects %s local file before HTTP",
  async (kind) => {
    const f = await setup();
    const bytes =
      kind === "empty"
        ? new Uint8Array()
        : new Uint8Array(
            kind === "oversized" ? MAX_AI_AUDIO_INPUT_BYTES + 1 : 44,
          );
    const file = audioFile(
      "rejected.wav",
      bytes,
      kind === "wrong MIME" ? "text/plain" : "audio/wav",
    );
    fireEvent.change(screen.getByLabelText("Verification audio"), {
      target: { files: [file] },
    });
    await screen.findByLabelText(
      "Choose a recognized local audio file within the 1 MiB recording/upload bound.",
    );
    expect(button("Test AI connection")).toHaveProperty("disabled", true);
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    expect(f.http.records).toEqual([]);
  },
);
it("real Cancel of held Save closes HTTP and releases audio without saving or stale failure", async () => {
  const f = await setup();
  f.http.state.mode = "held";
  await sample(f);
  await f.user.click(button("Save AI connection"));
  await f.http.held;
  await f.user.click(button("Cancel transcription"));
  await heldClosed(f);
  expect(screen.getByLabelText("Verification audio")).toHaveProperty(
    "value",
    "",
  );
  expect(button("Save AI connection")).toHaveProperty("disabled", true);
  expect(readDeviceRows()).toEqual([]);
  expect(
    screen.queryByLabelText(/AI service|aborted|transcription failed/),
  ).toBeNull();
  expect(f.http.records).toHaveLength(1);
});
it("saved workspace Cancel ends only the current transcript; the verified saved connection remains", async () => {
  const f = await setup();
  const id = await save(f);
  f.http.state.mode = "held";
  await sample(f, "Audio to transcribe");
  await f.user.click(button("Transcribe audio"));
  await f.http.held;
  await f.user.click(button("Cancel transcription"));
  await heldClosed(f);
  expect(storedDraft(id)).toMatchObject({
    family: "elevenlabs_scribe",
    apiKey: "",
  });
  expect(readDeviceRows()).toHaveLength(1);
  expect(screen.getByLabelText("Transcript").textContent).toBe("");
  expect(screen.getByLabelText("Audio to transcribe")).toHaveProperty(
    "value",
    "",
  );
  expect(f.http.records).toHaveLength(2);
});
it.each(["unmount", "lock", "provider change"])(
  "actual %s ends a held owned Test and clears private inputs",
  async (end) => {
    const f = await setup();
    f.http.state.mode = "held";
    await sample(f);
    await f.user.click(button("Test AI connection"));
    await f.http.held;
    if (end === "unmount") f.mounted.unmount();
    else if (end === "lock") act(() => vaultStore.lock());
    else await act(async () => f.mounted.navigate("byo-ai"));
    await heldClosed(f);
    expect(readDeviceRows()).toEqual([]);
    expect(f.http.records).toHaveLength(1);
    if (end === "lock") {
      expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
        "value",
        "",
      );
      expect(screen.getByLabelText("Verification audio")).toHaveProperty(
        "value",
        "",
      );
    }
  },
);
it("changing a saved endpoint loses credential retention and clears old local audio", async () => {
  const f = await setup();
  await save(f);
  await sample(f);
  field("API base URL", "https://other.example/v1");
  expect(screen.getByLabelText("Verification audio")).toHaveProperty(
    "value",
    "",
  );
  expect(button("Test AI connection")).toHaveProperty("disabled", true);
  await f.user.upload(
    screen.getByLabelText("Verification audio"),
    audioFile("new-target.wav"),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Selected audio")).toHaveProperty(
      "value",
      "new-target.wav",
    ),
  );
  expect(button("Test AI connection")).toHaveProperty("disabled", true);
  expect(f.http.records).toHaveLength(1);
});
it("a late rejected-file read cannot replace the newer selected audio or restore its failure", async () => {
  const f = await setup();
  const original = FileReader.prototype.readAsArrayBuffer;
  let held: FileReader | undefined;
  let rejected: Blob | undefined;
  vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementationOnce(
    function (this: FileReader, blob) {
      held = this;
      rejected = blob;
    },
  );
  await f.user.upload(
    screen.getByLabelText("Verification audio"),
    audioFile("earlier-bad.wav", new Uint8Array(44)),
  );
  await sample(f, "Verification audio", audioFile("current.wav"));
  if (!held || !rejected) throw new Error("Expected held local file read");
  const ended = new Promise<void>((resolve) =>
    held?.addEventListener("loadend", () => resolve(), { once: true }),
  );
  await act(async () => {
    if (held && rejected) original.call(held, rejected);
    await ended;
  });
  expect(screen.getByLabelText("Selected audio")).toHaveProperty(
    "value",
    "current.wav",
  );
  expect(screen.queryByLabelText(/Choose a recognized local audio/)).toBeNull();
  await f.user.click(button("Test AI connection"));
  await screen.findByLabelText("Model inference verified");
  expect(f.http.records).toHaveLength(1);
});
