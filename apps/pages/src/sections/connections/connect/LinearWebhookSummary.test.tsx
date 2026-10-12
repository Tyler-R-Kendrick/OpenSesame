/** @vitest-environment jsdom */
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type CopyResult, vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { LinearWebhookSummary } from "./LinearWebhookSummary.js";
import { LinearFlashHarness } from "./linear-flash.test-support.js";
import {
  createLinearUiConnection,
  installLinearUiWebhook,
} from "./linear-ui.test-support.js";

function WebhookScope(props: ComponentProps<typeof LinearWebhookSummary>) {
  return (
    <LinearFlashHarness>
      {(report) => (
        <LinearWebhookSummary
          {...props}
          onFlash={(flash) => {
            report(flash);
            props.onFlash(flash);
          }}
        />
      )}
    </LinearFlashHarness>
  );
}

const originalFetch = linearApiSeams.fetch;
const originalCopy = vaultHooksSeams.useCopySecret;
const copy = vi.fn<(value: string) => Promise<CopyResult>>();
let connectorId = "";
beforeEach(async () => {
  kvForgetAll();
  clearNotices();
  connectorId = await createLinearUiConnection();
  await installLinearUiWebhook(connectorId);
  copy.mockReset().mockResolvedValue("copied");
  vaultHooksSeams.useCopySecret = () => copy;
});
afterEach(() => {
  cleanup();
  linearApiSeams.fetch = originalFetch;
  vaultHooksSeams.useCopySecret = originalCopy;
  kvForgetAll();
  clearNotices();
});

it("copies the sealed signing secret only on a user's click and never renders it", async () => {
  const view = render(
    <WebhookScope connectorId={connectorId} onFlash={vi.fn()} />,
  );
  expect(copy).not.toHaveBeenCalled();
  const control = screen.getByRole("button", {
    name: "Copy webhook signing secret",
  });
  expect(control.textContent?.trim()).toBe("");
  expect(control.getAttribute("title")).toContain("Linear-Signature");
  expect(view.container.innerHTML).not.toContain("private-signing-secret");
  await userEvent.click(
    screen.getByRole("button", { name: "Copy webhook signing secret" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: "Signing secret copied" }),
    ).toBeTruthy(),
  );
  expect(copy).toHaveBeenCalledWith("private-signing-secret");
  expect(view.container.innerHTML).not.toContain("private-signing-secret");
});

it("reports denied clipboard access without claiming a successful copy or revealing the secret", async () => {
  copy.mockRejectedValue(new Error("private-signing-secret"));
  const onFlash = vi.fn();
  const view = render(
    <WebhookScope connectorId={connectorId} onFlash={onFlash} />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Copy webhook signing secret" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith({
      tone: "err",
      text: "Could not copy the signing secret. Check clipboard access and try again.",
    }),
  );
  expect(view.container.innerHTML).not.toContain("private-signing-secret");
  expect(screen.queryByText(/Signing secret copied/)).toBeNull();
  expect(
    screen.getByRole("img", { name: /Could not copy the signing secret/ }),
  ).toBeTruthy();
  expect(listNotices().map((notice) => notice.body)).toEqual([
    "Could not copy the signing secret. Check clipboard access and try again.",
  ]);
  expect(JSON.stringify(listNotices())).not.toContain("private-signing-secret");
});
