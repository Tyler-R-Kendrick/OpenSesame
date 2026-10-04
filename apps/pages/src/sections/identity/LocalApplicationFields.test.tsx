/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import { ScopeRolesField } from "./LocalApplicationFields.js";

const many = Array.from({ length: 33 }, (_, i) => `scope:${i}`).join(" ");
const SENTENCE = "Use at most 32 scopes.";

afterEach(() => {
  clearNotices();
  cleanup();
});

const field = (applicationId: string, scopes: string) => (
  <ScopeRolesField
    applicationId={applicationId}
    scopes={scopes}
    value={[]}
    onChange={() => undefined}
  />
);

it("marks the scopes field and trays the sentence when there are too many", async () => {
  render(field("app-1", many));
  expect(screen.getByRole("img", { name: SENTENCE })).toBeTruthy();
  expect(screen.queryByText("Roles allowed per scope")).toBeNull();
  await expectInTray(SENTENCE);
});

it("shows the roles, and no mark, within the limit", () => {
  render(field("app-1", "openid profile"));
  expect(screen.getByText("Roles allowed per scope")).toBeTruthy();
  expect(screen.queryByRole("img", { name: SENTENCE })).toBeNull();
});

it("keeps each application's scope notice apart, and clears them one at a time", async () => {
  const both = (a: string, b: string) => (
    <>
      {field("app-a", a)}
      {field("app-b", b)}
    </>
  );
  const view = render(both(many, many));
  await expectInTray(SENTENCE);
  const ids = () =>
    listNotices()
      .map((notice) => notice.id)
      .sort();
  expect(ids()).toEqual([
    "identity:application-scopes:app-a",
    "identity:application-scopes:app-b",
  ]);
  view.rerender(both("openid", many));
  expect(ids()).toEqual(["identity:application-scopes:app-b"]);
  view.rerender(both("openid", "openid"));
  expect(ids()).toEqual([]);
});
