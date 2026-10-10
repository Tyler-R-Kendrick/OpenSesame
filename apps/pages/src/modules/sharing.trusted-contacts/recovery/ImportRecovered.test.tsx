/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { ImportRecovered } from "./ImportRecovered.js";
import { CXF, readBlob } from "./recovery.test-support.js";
import type { Recovered } from "./use-recovered.js";

const original = { ...vaultHooksSeams };
const applyImport = vi.fn(async () => 1);
const item: Recovered = {
  requestId: "r1",
  label: "Family",
  text: JSON.stringify(CXF),
  safe: null,
};

beforeEach(() => {
  applyImport.mockClear();
  Object.defineProperty(File.prototype, "text", {
    configurable: true,
    value(this: Blob) {
      return readBlob(this);
    },
  });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [], folders: [] }),
    useVaultStore: () => ({ applyImport, importSealed: async () => 0 }),
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
});

function open() {
  const onImported = vi.fn();
  render(
    <ImportRecovered
      item={item}
      onClose={() => undefined}
      onImported={onImported}
    />,
  );
  return { onImported };
}

describe("importing what a recovery handed back", () => {
  it("reports it once the recovered items are in the vault", async () => {
    const { onImported } = open();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Import 1 item/i }),
    );
    await screen.findByText("Imported");
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("does not report another file chosen from the sheet's own key as the recovered items", async () => {
    const { onImported } = open();
    await screen.findByRole("combobox", { name: "Read it as" });
    await userEvent.click(
      screen.getByRole("button", { name: "Choose another file" }),
    );
    await userEvent.upload(
      screen.getByLabelText("Choose a file to import"),
      new File(["API_KEY=sk-123\n"], "app.env", { type: "text/plain" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Import 1 item/i }),
    );
    await screen.findByText("Imported");
    expect(applyImport).toHaveBeenCalledTimes(1);
    expect(onImported).not.toHaveBeenCalled();
  });
});
