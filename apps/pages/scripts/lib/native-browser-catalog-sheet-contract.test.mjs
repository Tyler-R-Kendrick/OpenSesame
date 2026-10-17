import { describe, expect, it } from "vitest";
import { waitForModelProviderSheetKeyField } from "./native-browser-catalog-sheet-contract.mjs";

describe("waitForModelProviderSheetKeyField", () => {
  it("waits for a password input to attach inside the live dialog", async () => {
    const calls = [];
    const dialog = {
      locator(selector) {
        calls.push(["locator", selector]);
        return {
          first() {
            return {
              async waitFor(options) {
                calls.push(["waitFor", options]);
              },
            };
          },
        };
      },
    };
    await waitForModelProviderSheetKeyField(dialog);
    expect(calls).toEqual([
      ["locator", 'input[type="password"]'],
      ["waitFor", { state: "attached", timeout: 15_000 }],
    ]);
  });
});
