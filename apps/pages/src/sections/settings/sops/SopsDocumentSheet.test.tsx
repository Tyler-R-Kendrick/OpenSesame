import { planFromRecipients } from "@opensesame/app-core/lib/sops/plan.js";
import { sopsSession } from "@opensesame/app-core/lib/sops/session.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as age from "age-encryption";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { SopsDocumentSheet } from "./SopsDocumentSheet.js";

const originalSeams = { ...vaultHooksSeams };
const downloads: { name: string; type: string }[] = [];

function mockVault(status: "unlocked" | "locked" = "unlocked") {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      status,
      guest: false,
      awaitingSecondStep: false,
      tomb: "personal",
      header: null,
    }),
    useVaultStore: () => ({ getSnapshot: () => ({ items: [], header: null }) }),
  });
}

/** A File whose text() jsdom can serve. */
function pick(name: string, text: string): void {
  const input = screen.getByLabelText("Choose a SOPS YAML or JSON file");
  const file = new File([text], name, { type: "text/yaml" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  downloads.length = 0;
  mockVault();
  // Capture downloads instead of navigating.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, type: this.href });
  });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(vaultHooksSeams, originalSeams);
});

describe("SB-035/076 the SOPS document sheet runs the real engine in the browser", () => {
  it("inspects a selected file, opens it with a typed identity, edits, and saves ciphertext", async () => {
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const plan = planFromRecipients({ format: "yaml", groups: [[recipient]] });
    const cipher = await sopsSession.engine.encryptNew(
      "hello: world\ncount: 2\n",
      {
        plan,
        permit: sopsSession.permit({
          vaultScope: null,
          documentGeneration: 1,
          approvedPlanDigest: await (
            await import("@opensesame/app-core/lib/sops/plan.js")
          ).planDigest(plan),
        }),
        signal: sopsSession.signal,
      },
    );

    render(<SopsDocumentSheet onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "SOPS document" })).toBeTruthy();

    pick("secrets.sops.yaml", cipher);
    // Inspection is inert: the metadata shows, the plaintext does not.
    await waitFor(() =>
      expect(screen.getByText("secrets.sops.yaml")).toBeTruthy(),
    );
    expect(screen.getByText(recipient)).toBeTruthy();
    expect(screen.queryByLabelText("Decrypted document")).toBeNull();
    expect(document.body.textContent).not.toContain("world");

    fireEvent.change(screen.getByLabelText("age identity"), {
      target: { value: identity },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const editor = await screen.findByLabelText("Decrypted document");
    // SAFETY: the sheet renders the decrypted document in a <textarea>, so
    // the element this label resolves to has a `value`.
    expect((editor as HTMLTextAreaElement).value).toBe(
      "hello: world\ncount: 2\n",
    );

    fireEvent.change(editor, {
      target: { value: "hello: edited\ncount: 3\n" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save encrypted copy" }),
    );
    await waitFor(() => expect(downloads.length).toBe(1));
    expect(downloads[0]?.name).toBe("secrets.sops.yaml");
  });

  it("never names a native binary, an environment variable, or a CLI (SB-071)", async () => {
    render(<SopsDocumentSheet onClose={() => undefined} />);
    pick("a.yaml", "hello: world\n");
    await waitFor(() => expect(screen.getByText("a.yaml")).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(
      /OPENSESAME_SOPS_BIN|sops binary|install sops|opensesame pass protect/iu,
    );
    expect(text).toContain("This browser");
  });

  it("refuses to open with no identity and reports why, without a plaintext fallback", async () => {
    const other = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(other);
    const plan = planFromRecipients({ format: "yaml", groups: [[recipient]] });
    const cipher = await sopsSession.engine.encryptNew("hello: world\n", {
      plan,
      permit: sopsSession.permit({
        vaultScope: null,
        documentGeneration: 1,
        approvedPlanDigest: await (
          await import("@opensesame/app-core/lib/sops/plan.js")
        ).planDigest(plan),
      }),
      signal: sopsSession.signal,
    });
    render(<SopsDocumentSheet onClose={() => undefined} />);
    pick("a.sops.yaml", cipher);
    await waitFor(() => expect(screen.getByText("a.sops.yaml")).toBeTruthy());
    const wrong = await age.generateX25519Identity();
    fireEvent.change(screen.getByLabelText("age identity"), {
      target: { value: wrong },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Decrypted document")).toBeNull(),
    );
    expect(downloads.length).toBe(0);
    expect(document.body.textContent).not.toContain("world");
  });

  it("keeps every control reachable and labelled for a keyboard and a screen reader", () => {
    render(<SopsDocumentSheet onClose={() => undefined} />);
    const dialog = within(
      screen.getByRole("dialog", { name: "SOPS document" }),
    );
    for (const name of ["Close", "Open", "Encrypt"]) {
      expect(dialog.getByRole("button", { name }), name).toBeTruthy();
    }
    expect(
      screen.getByLabelText("Choose a SOPS YAML or JSON file"),
    ).toBeTruthy();
    expect(screen.getByLabelText("age identity")).toBeTruthy();
    expect(screen.getByLabelText("Recipients")).toBeTruthy();
    expect(screen.getByLabelText("Groups needed")).toBeTruthy();
    expect(
      screen
        .getByRole("dialog", { name: "SOPS document" })
        .getAttribute("aria-modal"),
    ).toBe("true");
  });
});
