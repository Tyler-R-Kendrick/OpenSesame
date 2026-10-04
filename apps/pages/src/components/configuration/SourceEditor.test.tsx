/** @vitest-environment jsdom */
import type { ConfigDiagnostic } from "@opensesame/app-core/lib/configuration/types.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceEditor } from "./SourceEditor.js";

afterEach(() => {
  cleanup();
  clearNotices();
});

const editor = (diagnostics: readonly ConfigDiagnostic[]) => (
  <SourceEditor
    id="app-1"
    value="name: x"
    diagnostics={diagnostics}
    onChange={() => undefined}
  />
);

describe("SourceEditor", () => {
  it("marks an invalid draft and raises nothing in the tray", () => {
    render(
      editor([
        { severity: "error", message: "name is required", code: "required" },
      ]),
    );
    expect(screen.getByRole("img", { name: "name is required" })).toBeTruthy();
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(listNotices()).toHaveLength(0);
  });

  it("wears no mark for a draft that reads", () => {
    render(editor([]));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBeNull();
  });
});
