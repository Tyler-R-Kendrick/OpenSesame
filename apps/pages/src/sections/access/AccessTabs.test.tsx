/** @vitest-environment jsdom */
import { ACCESS_TARGETS } from "@opensesame/app-core/tutorial/registry/access-catalog.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { declareTutorialForTest } from "../../modules/tutorial-test-realm.js";
import { AccessTabLink } from "./AccessTabs.js";

let undeclare: () => void;
beforeAll(async () => {
  // The tab names its guide target, declared the way the loader would.
  undeclare = await declareTutorialForTest("access.authority", {
    targets: ACCESS_TARGETS,
  });
});
afterAll(() => undeclare());
afterEach(cleanup);

function tab(waiting?: number) {
  return render(
    <MemoryRouter>
      <AccessTabLink
        guideId="access.requests"
        label="Requests"
        to="/access?view=requests"
        current={false}
        waiting={waiting}
      />
    </MemoryRouter>,
  );
}

describe("a tab with requests waiting", () => {
  it("draws no mark when nothing waits", () => {
    tab();
    expect(screen.queryByRole("img")).toBeNull();
    tab(0);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws one warning glyph that says how many wait, in its name and title", () => {
    tab(1);
    const mark = screen.getByRole("img", { name: "1 request waiting" });
    expect(mark.getAttribute("title")).toBe("1 request waiting");
    cleanup();
    tab(3);
    expect(
      screen.getByRole("img", { name: "3 requests waiting" }),
    ).toBeTruthy();
  });

  it("stays a tab named for its page", () => {
    tab(2);
    expect(screen.getByRole("tab", { name: /^Requests/ })).toBeTruthy();
  });
});
