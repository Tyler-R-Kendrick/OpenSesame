/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HostAuthorizationCeremony,
  hostCeremonySeams,
} from "./HostAuthorizationCeremony.js";

const seam = { authenticate: vi.fn(), authorize: vi.fn() };
const original = { ...hostCeremonySeams };
const request = {
  operation: "agent.browser.control",
  target_id: "run-a",
  transition: "take",
} as const;
beforeEach(() => {
  hostCeremonySeams.authenticateBrowser = seam.authenticate;
  hostCeremonySeams.authorizeHost = seam.authorize;
  seam.authenticate.mockReset();
  seam.authorize.mockReset();
});
afterEach(() => {
  cleanup();
  Object.assign(hostCeremonySeams, original);
});

it("requires separate explicit Identity and purpose approvals before releasing elevation", async () => {
  seam.authenticate.mockResolvedValue(null);
  seam.authorize.mockResolvedValue("e".repeat(64));
  const complete = vi.fn();
  render(
    <HostAuthorizationCeremony
      request={request}
      onComplete={complete}
      onCancel={() => {}}
    />,
  );
  expect(seam.authenticate).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Identity verification" }),
  );
  await screen.findByText("Approve this control transition");
  expect(complete).not.toHaveBeenCalled();
  expect(seam.authorize).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Identity verification" }),
  );
  await waitFor(() => expect(complete).toHaveBeenCalledWith("e".repeat(64)));
  expect(seam.authorize.mock.calls[0][0]).toEqual(request);
});

it("aborts an old request when the displayed run changes and cannot apply its late result", async () => {
  let resolve = () => {};
  seam.authenticate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = () => done(null);
      }),
  );
  const complete = vi.fn();
  const view = render(
    <HostAuthorizationCeremony
      request={request}
      onComplete={complete}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open Identity verification" }),
  );
  const signal: AbortSignal = seam.authenticate.mock.calls[0][0];
  view.rerender(
    <HostAuthorizationCeremony
      request={{ ...request, target_id: "run-b" }}
      onComplete={complete}
      onCancel={() => {}}
    />,
  );
  expect(signal.aborted).toBe(true);
  resolve();
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  expect(screen.getByText("run-b")).toBeTruthy();
  expect(screen.getByText("Identify this browser")).toBeTruthy();
});

it("cancel and unmount abort verification instead of retaining a popup authorization", () => {
  seam.authenticate.mockImplementation(() => new Promise(() => {}));
  const cancel = vi.fn();
  const view = render(
    <HostAuthorizationCeremony onComplete={() => {}} onCancel={cancel} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open Identity verification" }),
  );
  const signal: AbortSignal = seam.authenticate.mock.calls[0][0];
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(signal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  view.unmount();
});
