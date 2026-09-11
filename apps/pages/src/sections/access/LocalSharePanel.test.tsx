/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localRequestFixture } from "../../lib/local-request.fixture.js";
import { lockAllTombs } from "../../lib/vfs.js";
import { LocalSharePanel } from "./LocalSharePanel.js";

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shares a vault with a person from the grants command", async () => {
  const fixture = await localRequestFixture();
  render(<LocalSharePanel tomb={fixture.tomb} />);
  await userEvent.click(screen.getByRole("button", { name: "Grant access" }));
  await waitFor(() => screen.getByLabelText("Identity"));
  await userEvent.selectOptions(screen.getByLabelText("Resource"), "Vault");
  await userEvent.selectOptions(screen.getByLabelText("Policy"), "Open");
  await userEvent.selectOptions(screen.getByLabelText("Duration"), "1 hour");
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: /→ / })).toBeTruthy(),
  );
});
