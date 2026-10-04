/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FailureNotice } from "./FailureNotice.js";

describe("FailureNotice", () => {
  afterEach(() => {
    cleanup();
    clearNotices();
  });

  it("puts the sentence in the tray and nothing in the page", () => {
    const { container } = render(
      <FailureNotice id="area:thing" title="Thing" message="It failed." />,
    );
    expect(container.firstChild).toBeNull();
    expect(listNotices()).toMatchObject([
      { id: "area:thing", kind: "status", tone: "err", title: "Thing" },
    ]);
    expect(listNotices()[0]?.body).toBe("It failed.");
  });

  it("raises nothing for an empty message", () => {
    render(<FailureNotice id="area:thing" title="Thing" message="" />);
    render(<FailureNotice id="area:other" title="Other" message={null} />);
    expect(listNotices()).toHaveLength(0);
  });

  it("keeps one notice per id as the sentence changes", () => {
    const { rerender } = render(
      <FailureNotice id="area:thing" title="Thing" message="First." />,
    );
    rerender(<FailureNotice id="area:thing" title="Thing" message="Second." />);
    expect(listNotices().map((notice) => notice.body)).toEqual(["Second."]);
  });

  it("clears the notice when the failure clears while mounted", () => {
    const { rerender } = render(
      <FailureNotice id="area:thing" title="Thing" message="It failed." />,
    );
    rerender(<FailureNotice id="area:thing" title="Thing" message={null} />);
    expect(listNotices()).toHaveLength(0);
  });

  it("leaves the notice standing when the screen goes away", () => {
    const { unmount } = render(
      <FailureNotice id="area:thing" title="Thing" message="It failed." />,
    );
    unmount();
    expect(listNotices()).toHaveLength(1);
  });

  it("does not clear another screen's notice on mount with no failure", () => {
    render(
      <FailureNotice id="area:thing" title="Thing" message="It failed." />,
    );
    cleanup();
    render(<FailureNotice id="area:thing" title="Thing" message={null} />);
    expect(listNotices()).toHaveLength(1);
  });

  it("can raise a warning", () => {
    render(<FailureNotice id="a:b" title="B" message="Careful." tone="warn" />);
    expect(listNotices()[0]?.tone).toBe("warn");
  });
});
