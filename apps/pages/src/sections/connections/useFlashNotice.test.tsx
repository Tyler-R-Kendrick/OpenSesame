/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFlashNotice } from "./useFlashNotice.js";

afterEach(() => {
  cleanup();
  clearNotices();
});

function mount(initial: Flash | null) {
  return renderHook(
    ({ flash }: { flash: Flash | null }) =>
      useFlashNotice(flash, "workos", "WorkOS"),
    { initialProps: { flash: initial } },
  );
}

describe("a connector page's failure mark, mirrored into the bell", () => {
  it("says the sentence as a notice, in the mark's own tone", () => {
    const hook = mount({ tone: "err", text: "Connect refused the key." });
    expect(listNotices()).toMatchObject([
      {
        id: "connector:workos",
        tone: "err",
        title: "WorkOS",
        body: "Connect refused the key.",
      },
    ]);
    hook.rerender({
      flash: { tone: "warn", text: "Consent was not finished." },
    });
    expect(listNotices()).toMatchObject([
      {
        id: "connector:workos",
        tone: "warn",
        body: "Consent was not finished.",
      },
    ]);
  });

  it("draws nothing for a success, and clears a failure the success follows", () => {
    const hook = mount({ tone: "err", text: "Connect refused the key." });
    hook.rerender({ flash: { tone: "ok", text: "WorkOS is ready." } });
    expect(listNotices()).toEqual([]);
  });

  it("does not outlive the page it is a condition of", () => {
    const hook = mount({ tone: "err", text: "Connect refused the key." });
    hook.unmount();
    expect(listNotices()).toEqual([]);
  });
});
