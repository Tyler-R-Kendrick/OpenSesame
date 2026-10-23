/** @vitest-environment jsdom */
import {
  clearNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { GateNoticeSeat, Notices } from "./Notices.js";

function raiseNotice() {
  act(() => {
    setStatusNotice({
      id: "unlock:code",
      tone: "warn",
      title: "Unlock code",
      body: "Use the code delivered to this device.",
    });
  });
}

afterEach(() => {
  cleanup();
  clearNotices();
});

describe("a shellless screen's notice region", () => {
  it("keeps the flow fallback before a screen that has no notice seat", async () => {
    const { container } = render(
      <MemoryRouter>
        <Notices shellless>
          <main>
            <button type="button">Continue</button>
          </main>
        </Notices>
      </MemoryRouter>,
    );
    raiseNotice();
    const corner = container.querySelector(".notice-corner");
    const main = container.querySelector("main");
    if (!corner || !main) throw new Error("notice and screen must render");
    expect(
      corner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Notifications — 1 pending" }),
    );
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
  });

  it("keeps the bell inside the gate-owned flow region without remounting the form", async () => {
    const lifecycle = { mounts: 0, unmounts: 0 };
    function Screen({ seated }: { seated: boolean }) {
      useEffect(() => {
        lifecycle.mounts += 1;
        return () => {
          lifecycle.unmounts += 1;
        };
      }, []);
      return (
        <main>
          <div className="unlock__card">
            {seated ? <GateNoticeSeat /> : null}
            <input aria-label="PIN" defaultValue="" />
          </div>
          <aside aria-label="Release notes">
            <button type="button">Latest</button>
          </aside>
        </main>
      );
    }
    const tree = (seated: boolean) => (
      <MemoryRouter>
        <Notices shellless>
          <Screen seated={seated} />
        </Notices>
      </MemoryRouter>
    );
    const { container, rerender } = render(tree(true));
    const input = screen.getByRole("textbox", { name: "PIN" });
    await userEvent.type(input, "2468");
    raiseNotice();
    const bell = screen.getByRole("button", {
      name: "Notifications — 1 pending",
    });
    expect(bell.closest(".gate-notice-seat")?.parentElement?.className).toBe(
      "unlock__card",
    );
    expect(
      screen
        .getByRole("complementary", { name: "Release notes" })
        .contains(bell),
    ).toBe(false);
    expect(screen.getByRole("textbox", { name: "PIN" })).toBe(input);
    expect(screen.getByDisplayValue("2468")).toBe(input);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
    rerender(tree(false));
    expect(container.querySelector(".gate-notice-seat")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Notifications — 1 pending" }),
    ).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "PIN" })).toBe(input);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("keeps the screen mounted without a second bell when its shell owns notices", () => {
    render(
      <MemoryRouter>
        <Notices shellless={false}>
          <main>
            <GateNoticeSeat />
            <input aria-label="PIN" />
          </main>
        </Notices>
      </MemoryRouter>,
    );
    raiseNotice();
    expect(screen.getByRole("textbox", { name: "PIN" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Notifications —/ }),
    ).toBeNull();
  });
});
