import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { LocalSharePanel } from "./LocalSharePanel.js";

// The share + and its form are the Access walkthrough's targets, which the
// access capability declares when it activates.
let revokeRealm = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

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
  const grant = screen.getByRole("button", { name: "Grant identity share" });
  await waitFor(() => {
    expect(grant instanceof HTMLButtonElement && !grant.disabled).toBe(true);
  });
  await userEvent.click(grant);
  await waitFor(() => screen.getByLabelText("Identity"));
  await userEvent.selectOptions(screen.getByLabelText("Resource"), "Vault");
  await userEvent.selectOptions(screen.getByLabelText("Policy"), "Open");
  await userEvent.selectOptions(screen.getByLabelText("Duration"), "1 hour");
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: /→ / })).toBeTruthy(),
  );
});
