/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  decideRemotePreview,
  remotePreviewSnapshot,
  requestRemoteConsent,
} from "../agents/ag-ui/consent.js";
import { RemoteSupportPreview } from "./RemoteSupportPreview.js";

afterEach(cleanup);
const payload = Object.freeze({
  version: 2 as const,
  question: "Help with locking",
  pageId: "pages",
  route: "vault",
  featureIds: Object.freeze(["vault.lock"]),
});
it("requires a human decision over the exact payload and spends it once", async () => {
  render(<RemoteSupportPreview warning="Review before sending" />);
  let pending: Promise<boolean> = Promise.resolve(false);
  act(() => {
    pending = requestRemoteConsent(
      "https://support.example/api",
      payload,
      new AbortController().signal,
    );
  });
  expect(screen.getByText(/Help with locking/)).toBeTruthy();
  const id = remotePreviewSnapshot()?.id ?? 0;
  fireEvent.click(screen.getByRole("button", { name: "Send once" }));
  expect(await pending).toBe(true);
  decideRemotePreview(id, true);
  expect(remotePreviewSnapshot()).toBeNull();
});
it("closing or aborting the preview refuses transmission", async () => {
  const view = render(<RemoteSupportPreview warning={null} />);
  let pending: Promise<boolean> = Promise.resolve(true);
  act(() => {
    pending = requestRemoteConsent(
      "https://support.example/api",
      payload,
      new AbortController().signal,
    );
  });
  view.unmount();
  expect(await pending).toBe(false);
  const controller = new AbortController();
  pending = requestRemoteConsent(
    "https://support.example/api",
    payload,
    controller.signal,
  );
  controller.abort();
  expect(await pending).toBe(false);
});
