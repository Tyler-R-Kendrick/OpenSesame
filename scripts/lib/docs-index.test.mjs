import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MARKER,
  adrRow,
  auditRow,
  evidenceOrder,
  evidenceRow,
  renderIndex,
  status,
  title,
} from "./docs-index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("docs index", () => {
  it("strips the ADR prefix from a title in either spelling", () => {
    expect(title("# ADR 0017: Host/Client product topology\n")).toBe(
      "Host/Client product topology",
    );
    expect(title("# ADR 0090 — The static front end\n")).toBe(
      "The static front end",
    );
  });

  it("escapes backslashes as well as pipes for a table cell", () => {
    expect(title("# A | B\n")).toBe(String.raw`A \| B`);
    expect(title(`${String.raw`# A \| B`}\n`)).toBe(String.raw`A \\\| B`);
  });

  it("reads the status in each of the three spellings", () => {
    expect(status("# T\n\n## Status\nAccepted\n")).toBe("Accepted");
    expect(status("# T\n\nStatus: proposed\n")).toBe("Proposed");
    expect(status("# T\n\n- **Status:** Accepted — implemented\n")).toBe(
      "Accepted",
    );
    expect(
      status("# T\n\nStatus: Accepted — §2 superseded by ADR 0099\n"),
    ).toBe("Accepted (partly superseded)");
    expect(status("# T\n")).toBe("—");
  });

  it("links each row to its file", () => {
    expect(
      adrRow("0005-x.md", "# ADR 0005: X\n\n## Status\nAccepted\n"),
    ).toEqual(["[0005](0005-x.md)", "X", "Accepted"]);
    expect(auditRow("2026-08-07-y.md", "# Audit — Y\n")).toEqual([
      "2026-08-07",
      "[Audit — Y](2026-08-07-y.md)",
    ]);
  });

  it("lists stable evidence slots by feature, project and platform", () => {
    const names = [
      "wallet/wallet/cross-platform",
      "unlock/pages/web",
      "unlock/desktop/macos",
    ];
    expect(names.sort(evidenceOrder)).toEqual([
      "unlock/desktop/macos",
      "unlock/pages/web",
      "wallet/wallet/cross-platform",
    ]);
    expect(
      evidenceRow("unlock/pages/web", "# Unlock — current state\n"),
    ).toEqual([
      "[`unlock/pages/web/`](unlock/pages/web/README.md)",
      "Unlock — current state",
    ]);
  });

  it("keeps the hand-written preamble and replaces only the table", () => {
    const first = renderIndex("# Title\n\nIntro.\n", ["A"], [["1"]]);
    expect(first).toBe(
      `# Title\n\nIntro.\n\n${MARKER}\n\n| A |\n|---|\n| 1 |\n`,
    );
    expect(renderIndex(first, ["A"], [["2"]])).toContain("| 2 |");
    expect(renderIndex(first, ["A"], [["2"]])).not.toContain("| 1 |");
  });

  // A child process over the whole docs tree: about 0.1s alone, but on a
  // loaded runner the spawn alone outlasted Vitest's 5s default and failed
  // a check whose indexes were current.
  it("the committed indexes are current", { timeout: 60_000 }, () => {
    expect(() =>
      execFileSync(
        "node",
        [join(root, "scripts", "quality", "docs-index.mjs"), "--check"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ).not.toThrow();
  });
});
