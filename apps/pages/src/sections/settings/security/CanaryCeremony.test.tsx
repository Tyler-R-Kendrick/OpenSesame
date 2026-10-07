/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CanaryCeremony, { canaryUiPorts } from "./CanaryCeremony.js";
const original = { ...canaryUiPorts };
afterEach(() => {
  cleanup();
  Object.assign(canaryUiPorts, original);
});
it("keeps unsupported owner management disabled without offering an alternate factor bypass", async () => {
  const api = await original.load();
  const create = vi.fn(api.createControlledCanary);
  canaryUiPorts.requireOwner = () => {};
  canaryUiPorts.load = async () => ({
    ...api,
    createControlledCanary: create,
    listControlledCanaries: async () => ({
      vaultIdentity: "owner",
      artifacts: [],
      events: [],
      durable: true,
    }),
  });
  render(<CanaryCeremony tomb="personal" supported={false} />);
  await waitFor(() => expect(screen.getByText("0 of 16")).toBeTruthy());
  const password = screen.getByLabelText("Current vault password");
  expect(password.hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Create and export canary" }),
  );
  expect(create).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      "requires one verified password protector and no additional factors",
    ),
  ).toBeTruthy();
});
it("discards an asynchronous initial status when the real owner has lost authority", async () => {
  const api = await original.load();
  let finish: (
    value: Awaited<ReturnType<typeof api.listControlledCanaries>>,
  ) => void = () => {
    throw new Error("Missing resolver");
  };
  const pending = new Promise<
    Awaited<ReturnType<typeof api.listControlledCanaries>>
  >((resolve) => {
    finish = resolve;
  });
  let owner = true;
  canaryUiPorts.requireOwner = () => {
    if (!owner) throw new Error("Owner locked");
  };
  canaryUiPorts.load = async () => ({
    ...api,
    listControlledCanaries: async () => pending,
  });
  render(<CanaryCeremony tomb="personal" supported />);
  await Promise.resolve();
  owner = false;
  finish({
    vaultIdentity: "private-owner",
    artifacts: [],
    events: [],
    durable: true,
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Create and export canary" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(screen.queryByText("private-owner")).toBeNull();
});

it("does not transfer a held ceremony into an actual freshly unlocked same-tomb successor", async () => {
  const { createRetiredCredentialFixture, PASSWORD } = await import(
    "@opensesame/app-core/lib/retired-credentials/test-support.js"
  );
  const fixture = await createRetiredCredentialFixture();
  const api = await original.load();
  let finish: (value: typeof api) => void = () => {
    throw new Error("Missing resolver");
  };
  const pending = new Promise<typeof api>((resolve) => {
    finish = resolve;
  });
  const create = vi.fn(api.createControlledCanary);
  let loads = 0;
  canaryUiPorts.requireOwner = (tomb) => {
    const state = fixture.store.getSnapshot();
    if (
      state.tomb !== tomb ||
      state.status !== "unlocked" ||
      state.guest ||
      state.decoy ||
      state.awaitingSecondStep
    )
      throw new Error("Owner unavailable");
  };
  canaryUiPorts.load = async () => {
    loads += 1;
    if (loads > 1) return pending;
    return {
      ...api,
      listControlledCanaries: async () => ({
        vaultIdentity: "owner",
        artifacts: [],
        events: [],
        durable: true,
      }),
    };
  };
  try {
    render(<CanaryCeremony tomb="personal" supported />);
    await waitFor(() => expect(screen.getByText("0 of 16")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Current vault password"), {
      target: { value: PASSWORD },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Create and export canary" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create and export canary" }),
    );
    await waitFor(() => expect(loads).toBe(2));
    fixture.store.lock();
    await fixture.store.unlock(PASSWORD);
    expect(fixture.store.getSnapshot().status).toBe("unlocked");
    expect(fixture.store.activeTomb()).toBe("personal");
    finish({ ...api, createControlledCanary: create });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("session"),
    );
    expect(create).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Current vault password").getAttribute("value"),
    ).toBe("");
  } finally {
    fixture.restore();
  }
}, 60000);
