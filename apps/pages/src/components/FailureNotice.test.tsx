/** @vitest-environment jsdom */
import {
  clearNotices,
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import { act, cleanup, render } from "@testing-library/react";
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

  it("does not re-raise a dismissed notice for an equal sentence", () => {
    const { rerender } = render(
      <FailureNotice id="area:thing" title="Thing" message="It failed." />,
    );
    act(() => dismissNotice("area:thing"));
    rerender(
      <FailureNotice id="area:thing" title="Thing" message="It failed." />,
    );
    expect(listNotices()).toHaveLength(0);
  });

  it("re-raises an equal sentence after a dismiss when the occurrence is new", () => {
    const { rerender } = render(
      <FailureNotice
        id="area:thing"
        title="Thing"
        message="It failed."
        occurrence={{}}
      />,
    );
    act(() => dismissNotice("area:thing"));
    expect(listNotices()).toHaveLength(0);
    rerender(
      <FailureNotice
        id="area:thing"
        title="Thing"
        message="It failed."
        occurrence={{}}
      />,
    );
    expect(listNotices().map((notice) => notice.body)).toEqual(["It failed."]);
  });

  it("dismisses the previous id's notice when the id changes", () => {
    const { rerender } = render(
      <FailureNotice id="item:a" title="Item" message="It failed." />,
    );
    rerender(<FailureNotice id="item:b" title="Item" message="It failed." />);
    expect(listNotices().map((notice) => notice.id)).toEqual(["item:b"]);
  });

  it("dismisses the previous id when the id changes and the failure is gone", () => {
    const { rerender } = render(
      <FailureNotice id="item:a" title="Item" message="It failed." />,
    );
    rerender(<FailureNotice id="item:b" title="Item" message={null} />);
    expect(listNotices()).toHaveLength(0);
  });
});
