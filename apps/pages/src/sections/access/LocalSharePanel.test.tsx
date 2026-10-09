import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
import { renderAccess as render } from "./workspace-test-support.js";

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
  render(
    <LocalSharePanel tomb={fixture.tomb} />,
    "/access?view=grants#identity-shares",
  );
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
  await waitFor(() =>
    expect(grant instanceof HTMLButtonElement && !grant.disabled).toBe(true),
  );
});

it("offers a new application and grants it a vault", async () => {
  const fixture = await localRequestFixture();
  render(
    <LocalSharePanel tomb={fixture.tomb} />,
    "/access?view=grants#identity-shares",
  );
  const grant = screen.getByRole("button", { name: "Grant identity share" });
  await waitFor(() => {
    expect(grant instanceof HTMLButtonElement && !grant.disabled).toBe(true);
  });
  await fixture.change({
    action: "create",
    kind: "application",
    name: "Payroll",
  });
  await userEvent.click(grant);
  const identity = await screen.findByLabelText("Identity");
  await waitFor(() => {
    expect(
      within(identity).getByRole("option", { name: "Payroll" }),
    ).toBeTruthy();
    expect(
      within(identity).getByRole("option", { name: "Test application" }),
    ).toBeTruthy();
  });
  expect(
    within(screen.getByLabelText("Resource")).getByRole("option", {
      name: "Folder",
    }),
  ).toBeTruthy();
  expect(
    within(screen.getByLabelText("Resource")).getByRole("option", {
      name: "Item",
    }),
  ).toBeTruthy();
  await userEvent.selectOptions(identity, "Payroll");
  await userEvent.selectOptions(screen.getByLabelText("Resource"), "Vault");
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: /Payroll →/ })).toBeTruthy(),
  );
  const payroll = (await readLocalDirectory(fixture.tomb)).entries.find(
    (row) => row.name === "Payroll",
  );
  const shares = await listLocalShares(fixture.tomb);
  expect(shares.some((share) => share.principalId === payroll?.id)).toBe(true);
  await waitFor(() =>
    expect(grant instanceof HTMLButtonElement && !grant.disabled).toBe(true),
  );
});

it("asks for approval before an agent share is active", async () => {
  const fixture = await localRequestFixture();
  await fixture.change({ action: "create", kind: "agent", name: "Helper" });
  render(
    <LocalSharePanel tomb={fixture.tomb} />,
    "/access?view=grants#identity-shares",
  );
  const grant = screen.getByRole("button", { name: "Grant identity share" });
  await waitFor(() => {
    expect(grant instanceof HTMLButtonElement && !grant.disabled).toBe(true);
  });
  await userEvent.click(grant);
  const identity = await screen.findByLabelText("Identity");
  await waitFor(() =>
    expect(
      within(identity).getByRole("option", { name: "Helper" }),
    ).toBeTruthy(),
  );
  await userEvent.selectOptions(identity, "Helper");
  await userEvent.click(
    screen.getByRole("button", { name: "Request approval" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Awaiting approval" })).toBeTruthy(),
  );
  const helper = (await readLocalDirectory(fixture.tomb)).entries.find(
    (row) => row.name === "Helper",
  );
  expect(
    (await listLocalShares(fixture.tomb)).some(
      (share) => share.principalId === helper?.id,
    ),
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Approve Helper" }));
  await waitFor(async () => {
    expect(
      (await listLocalShares(fixture.tomb)).some(
        (share) => share.principalId === helper?.id,
      ),
    ).toBe(true);
  });
  await waitFor(() =>
    expect(grant instanceof HTMLButtonElement && !grant.disabled).toBe(true),
  );
});
