/** @vitest-environment jsdom */
import { markDecoySession } from "@opensesame/app-core/lib/decoy-session.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionAnchor } from "../components/DecoyNavigationAnchor.js";
import {
  navigationGroup,
  pageMenu,
} from "../components/context-menu/page-menu.js";
import { railMenu } from "../components/context-menu/rail-menu.js";
import { AccountWebsiteRows } from "../sections/vault/AccountWebsiteRows.js";
import { makeAccount } from "../sections/vault/account.test-support.js";
import {
  navigateConsentWindow,
  runSessionNavigation,
  useSessionNavigationBoundary,
} from "./decoy-navigation.js";
afterEach(() => {
  cleanup();
  markDecoySession(false);
  vi.restoreAllMocks();
});
function Boundary() {
  useSessionNavigationBoundary();
  return (
    <SessionAnchor
      href="https://production.example.test/account"
      target="_blank"
    >
      External account
    </SessionAnchor>
  );
}
it("removes external hrefs in synthetic renders while preserving real and local navigation", () => {
  markDecoySession(true);
  const { container, rerender } = render(<Boundary />);
  expect(container.querySelector("a")?.getAttribute("href")).toBeNull();
  expect(container.querySelector("a")?.getAttribute("aria-disabled")).toBe(
    "true",
  );
  const local = vi.fn();
  expect(runSessionNavigation("/vault", local)).toBe(true);
  expect(local).toHaveBeenCalledOnce();
  markDecoySession(false);
  rerender(<Boundary />);
  expect(
    screen.getByRole("link", { name: "External account" }).getAttribute("href"),
  ).toBe("https://production.example.test/account");
});
it("prevents ordinary and middle clicks from an external link rendered before synthetic entry", () => {
  render(<Boundary />);
  const anchor = screen.getByRole("link", { name: "External account" });
  markDecoySession(true);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  const middle = new MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  fireEvent(anchor, click);
  fireEvent(anchor, middle);
  expect(click.defaultPrevented).toBe(true);
  expect(middle.defaultPrevented).toBe(true);
});
it("rechecks page and rail menu actions captured before the realm transition", () => {
  const anchor = document.createElement("a");
  anchor.href = "https://production.example.test/account";
  anchor.dataset.railTo = anchor.href;
  const click = vi.spyOn(anchor, "click").mockImplementation(() => {});
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const navigate = vi.fn();
  const page = pageMenu(anchor, "", navigate).flat();
  const rail = railMenu(anchor, false, navigate).flat();
  markDecoySession(true);
  for (const entry of [...page, ...rail])
    if (["link-open", "link-tab", "open", "tab"].includes(entry.id))
      entry.run();
  expect(click).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(
    pageMenu(anchor, "", navigate)
      .flat()
      .find((entry) => entry.id === "link-open")?.disabled,
  ).toBe(true);
  markDecoySession(false);
  page.find((entry) => entry.id === "link-open")?.run();
  page.find((entry) => entry.id === "link-tab")?.run();
  expect(click).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
});

it("renders an attacker-written production website in a synthetic account without an actionable anchor", () => {
  markDecoySession(true);
  const item = makeAccount({
    uris: [
      {
        id: "website",
        uri: "https://production.example.test/account",
        match: "exact",
      },
    ],
  });
  const { container } = render(
    <AccountWebsiteRows
      item={item}
      copying={{ copied: null, failed: null, copy: async () => {} }}
    />,
  );
  expect(
    screen.getByText("https://production.example.test/account"),
  ).toBeTruthy();
  const anchor = container.querySelector("a");
  expect(anchor?.getAttribute("href")).toBeNull();
  expect(anchor?.getAttribute("aria-disabled")).toBe("true");
});

it("rechecks captured browser-history menu actions whose prior origin is unknown", () => {
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  const forward = vi.spyOn(history, "forward").mockImplementation(() => {});
  const entries = navigationGroup();
  markDecoySession(true);
  entries.find((entry) => entry.id === "back")?.run();
  entries.find((entry) => entry.id === "forward")?.run();
  expect(back).not.toHaveBeenCalled();
  expect(forward).not.toHaveBeenCalled();
  expect(navigationGroup().find((entry) => entry.id === "back")?.disabled).toBe(
    true,
  );
  markDecoySession(false);
  entries.find((entry) => entry.id === "back")?.run();
  expect(back).toHaveBeenCalledOnce();
});

function LocalBoundary() {
  useSessionNavigationBoundary();
  return (
    <>
      <SessionAnchor href="/vault">Local vault</SessionAnchor>
      <SessionAnchor href="/vault" target="_blank">
        New vault tab
      </SessionAnchor>
    </>
  );
}
it("denies fresh contexts for internal links and modified gestures while preserving same-document routes", () => {
  markDecoySession(true);
  const { container } = render(<LocalBoundary />);
  const normal = screen.getByRole("link", { name: "Local vault" });
  expect(normal.getAttribute("href")).toBe("/vault");
  expect(
    container.querySelector('a[target="_blank"]')?.getAttribute("href"),
  ).toBeNull();
  for (const options of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { button: 1 },
  ]) {
    const event = new MouseEvent(options.button === 1 ? "auxclick" : "click", {
      bubbles: true,
      cancelable: true,
      ...options,
    });
    fireEvent(normal, event);
    expect(event.defaultPrevented).toBe(true);
  }
});
it("rechecks captured internal new-tab menu actions after synthetic entry", () => {
  const anchor = document.createElement("a");
  anchor.href = "/vault";
  anchor.dataset.railTo = "/vault";
  const click = vi.spyOn(anchor, "click").mockImplementation(() => {});
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const navigate = vi.fn();
  const page = pageMenu(anchor, "", navigate).flat();
  const rail = railMenu(anchor, false, navigate).flat();
  markDecoySession(true);
  page.find((entry) => entry.id === "link-tab")?.run();
  rail.find((entry) => entry.id === "tab")?.run();
  expect(open).not.toHaveBeenCalled();
  expect(
    pageMenu(anchor, "", navigate)
      .flat()
      .find((entry) => entry.id === "link-tab")?.disabled,
  ).toBe(true);
  page.find((entry) => entry.id === "link-open")?.run();
  rail.find((entry) => entry.id === "open")?.run();
  expect(click).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith("/vault");
  markDecoySession(false);
  page.find((entry) => entry.id === "link-tab")?.run();
  expect(open).toHaveBeenCalledOnce();
});

it("blocks a same-origin consent popup continuation after synthetic entry", () => {
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  markDecoySession(true);
  expect(() => navigateConsentWindow("/vault", window)).toThrow(
    "External navigation is unavailable",
  );
  expect(close).toHaveBeenCalledOnce();
});
it("blocks an internal target-blank anchor captured before the realm changed", () => {
  render(<LocalBoundary />);
  const anchor = screen.getByRole("link", { name: "New vault tab" });
  markDecoySession(true);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(anchor, click);
  expect(click.defaultPrevented).toBe(true);
});
