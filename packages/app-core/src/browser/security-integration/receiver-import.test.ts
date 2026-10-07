/** @vitest-environment jsdom */
import { File } from "node:buffer";
import { expect, it, vi } from "vitest";
import { getObservationReceiverStatus } from "../../lib/credential-observation/receiver.js";
import { publicVectorProvision } from "../../lib/credential-observation/vector-test-support.js";
import { deferred } from "../security/management.fixture.js";
import { receiverPanel } from "../security/receiver-panel.js";
import { click, field, ownerPanel, selectFile } from "./panel-dom.fixture.js";

function provision() {
  return {
    ...publicVectorProvision(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
}
it("rejects empty, oversize, malformed and unsafe pairing files without retaining a previously reviewed pairing", async () => {
  const f = await ownerPanel();
  document.body.append(
    receiverPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  selectFile(new File([JSON.stringify(provision())], "valid.json"));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      "Confirm destination: https://receiver.example",
    ),
  );
  selectFile();
  expect(document.body.textContent).toContain("No pairing selected.");
  for (const raw of [
    " ".repeat(8193),
    "malformed-json",
    JSON.stringify({
      ...provision(),
      origin: "https://receiver.example/secret-path",
    }),
  ]) {
    const before = f.messages.length;
    selectFile(new File([raw], "invalid.json"));
    await vi.waitFor(() => expect(f.messages).toHaveLength(before + 1));
    expect(f.messages.at(-1)).toBe("Pairing invalid or owner session closed.");
    expect(document.body.textContent).toContain("No pairing selected.");
    await click("Confirm receiver destination");
    expect(f.messages.at(-1)).toBe("Choose and review a pairing file.");
  }
  expect((await getObservationReceiverStatus("personal")).configured).toBe(
    false,
  );
});

it("cannot accept a file read belonging to a locked, disconnected or superseded genuine owner session", async () => {
  for (const interruption of ["lock", "reauthenticate", "disconnect"]) {
    const f = await ownerPanel();
    document.body.append(
      receiverPanel(f.bridge.client, (text) => f.messages.push(text)),
    );
    const started = deferred<void>();
    const resume = deferred<void>();
    const file = new File([JSON.stringify(provision())], "held.json");
    const read = file.text.bind(file);
    vi.spyOn(file, "text").mockImplementation(async () => {
      started.finish();
      await resume.promise;
      return read();
    });
    selectFile(file);
    await started.promise;
    if (interruption === "lock") f.bridge.client.lock();
    if (interruption === "disconnect") f.bridge.transport.close();
    if (interruption === "reauthenticate")
      await f.bridge.client.unlock(f.owner.password);
    resume.finish();
    await vi.waitFor(() =>
      expect(f.messages.at(-1)).toBe(
        "Pairing invalid or owner session closed.",
      ),
    );
    expect(document.body.textContent).toContain("No pairing selected.");
    await click("Confirm receiver destination");
    expect(f.messages.at(-1)).toBe("Choose and review a pairing file.");
    expect((await getObservationReceiverStatus("personal")).configured).toBe(
      false,
    );
    document.body.replaceChildren();
    f.bridge.close();
    await f.bridge.drain();
  }
});

it("clears password fields and preserves local evidence when management is attempted after worker disconnect", async () => {
  const f = await ownerPanel();
  document.body.append(
    receiverPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  f.bridge.close();
  const before = f.bridge.transport.sent.length;
  field("Current vault password for receiver").value = f.owner.password;
  await click("Remove observation receiver");
  expect(field("Current vault password for receiver").value).toBe("");
  expect(f.messages.at(-1)).toBe("Authenticate the owner again.");
  expect(f.bridge.transport.sent).toHaveLength(before);
  expect((await getObservationReceiverStatus("personal")).configured).toBe(
    false,
  );
});
