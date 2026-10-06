import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { ACCESS_TARGETS } from "@opensesame/app-core/tutorial/registry/access-catalog.js";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { declareTutorialForTest } from "../../modules/tutorial-test-realm.js";
import { PrivateRequestPanel } from "./PrivateRequestPanel.js";
afterEach(() => {
  cleanup();
  clearNotices();
});
let undeclare: () => void;
beforeAll(async () => {
  undeclare = await declareTutorialForTest("access.authority", {
    targets: ACCESS_TARGETS,
  });
});
afterAll(() => undeclare());
describe("private request native handoff", () => {
  it("prepares real command shapes without claiming to grant authority", () => {
    render(<PrivateRequestPanel />);
    fireEvent.click(screen.getByText("Prepare a native request"));
    fireEvent.change(screen.getByLabelText("Exact HTTPS destination"), {
      target: { value: "https://example.com/v1/me" },
    });
    fireEvent.change(screen.getByLabelText("Credential reference"), {
      target: { value: "op://Automation/Example/credential" },
    });
    fireEvent.click(screen.getByText("Prepare commands"));
    const commands = screen.getByLabelText("Native request commands");
    expect(commands.textContent).toContain(
      "'opensesame' 'password-agent' 'lease' 'approve'",
    );
    expect(commands.textContent).not.toContain("Consume approved lease");
    fireEvent.change(screen.getByLabelText("Existing lease ID (optional)"), {
      target: { value: "lease_123" },
    });
    fireEvent.click(screen.getByText("Prepare commands"));
    expect(commands.textContent).toContain(
      "'request' 'https://example.com/v1/me'",
    );
    expect(commands.textContent).toContain("'lease' 'revoke' 'lease_123'");
  });
  it("rejects plaintext credential input before preparing any command", () => {
    render(<PrivateRequestPanel />);
    fireEvent.change(screen.getByLabelText("Exact HTTPS destination"), {
      target: { value: "https://example.com" },
    });
    fireEvent.change(screen.getByLabelText("Credential reference"), {
      target: { value: "secret-canary" },
    });
    fireEvent.click(screen.getByText("Prepare commands"));
    expect(
      listNotices()
        .map((notice) => notice.body)
        .join(" "),
    ).toContain("reference");
    expect(screen.queryByLabelText("Native request commands")).toBeNull();
    expect(
      listNotices()
        .map((notice) => notice.body)
        .join(" "),
    ).not.toContain("secret-canary");
  });
});
