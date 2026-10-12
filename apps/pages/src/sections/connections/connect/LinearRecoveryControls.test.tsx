/** @vitest-environment jsdom */
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import {
  linearActorCleanupPending,
  readLinearConnector,
} from "@opensesame/app-core/lib/linear-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import {
  linearPublicRecord,
  updateLinearRecord,
} from "@opensesame/app-core/lib/linear-store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LinearActorCleanup,
  LinearReconnectHint,
  LinearWebhookRetry,
  linearReconnectActionTitle,
} from "./LinearRecoveryControls.js";
import { LinearWebhookSummary } from "./LinearWebhookSummary.js";
import {
  createLinearUiConnection,
  installLinearUiWebhook,
  linearUiResponse,
} from "./linear-ui.test-support.js";

const originalFetch = linearApiSeams.fetch;
let connectorId = "";
beforeEach(async () => {
  kvForgetAll();
  connectorId = await createLinearUiConnection();
  await installLinearUiWebhook(connectorId);
  await updateLinearRecord(connectorId, async (record, runtime) =>
    linearPublicRecord(record, {
      ...runtime,
      recovery: { workspaceId: "workspace-1", phase: "cleanup" },
    }),
  );
});
afterEach(() => {
  cleanup();
  linearApiSeams.fetch = originalFetch;
  kvForgetAll();
});

it("explains temporary admin consent and hides the old signing secret during recovery", () => {
  const view = render(
    <>
      <LinearReconnectHint connectorId={connectorId} />
      <LinearWebhookSummary connectorId={connectorId} onFlash={vi.fn()} />
    </>,
  );
  expect(
    screen.getByRole("img", { name: /temporary admin permission/ }),
  ).toBeTruthy();
  expect(
    linearReconnectActionTitle(connectorId, "Reconnect application"),
  ).toContain("Remove the previous webhook in its original workspace.");
  expect(
    screen.getByRole("img", { name: /Previous webhook cleanup pending/ }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Copy webhook signing secret" }),
  ).toBeNull();
  expect(view.container.innerHTML).not.toContain("private-signing-secret");
});

it("offers retry despite old webhook metadata and completes provider cleanup before reporting success", async () => {
  let removed = false;
  linearApiSeams.fetch = async (_url, init) => {
    const body = String(init?.body);
    if (body.includes("webhookDelete")) {
      removed = true;
      return linearUiResponse({ webhookDelete: { success: true } });
    }
    return linearUiResponse({
      webhooks: {
        nodes: removed
          ? []
          : [
              {
                id: "hook-1",
                url: "https://receiver.example.test/linear",
                resourceTypes: ["Issue"],
                enabled: true,
                label: null,
              },
            ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
  };
  const onChanged = vi.fn();
  const onFlash = vi.fn();
  render(
    <LinearWebhookRetry
      connectorId={connectorId}
      busy={false}
      onFlash={onFlash}
      onChanged={onChanged}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry webhook setup" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(removed).toBe(true);
  expect(readLinearConnector(connectorId)?.webhook).toBeNull();
  expect(readLinearConnector(connectorId)?.recovery).toBeUndefined();
  expect(onFlash).not.toHaveBeenCalled();
});

it("lets an unselected actor finish rejected-token cleanup without starting OAuth consent", async () => {
  await updateLinearRecord(connectorId, async (record, runtime) => {
    const user = record.secrets.linear_user_grant;
    if (!user) throw new Error("User grant fixture required");
    return linearPublicRecord(
      {
        ...record,
        secrets: { ...record.secrets, linear_cleanup_user: `[${user}]` },
      },
      runtime,
    );
  });
  const provider = vi
    .fn<typeof linearApiSeams.fetch>()
    .mockResolvedValue(new Response("", { status: 200 }));
  linearApiSeams.fetch = provider;
  const onChanged = vi.fn();
  const onFlash = vi.fn();
  render(
    <LinearActorCleanup
      connectorId={connectorId}
      actor="user"
      busy={false}
      onFlash={onFlash}
      onChanged={onChanged}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry authorization cleanup" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(linearActorCleanupPending(connectorId, "user")).toBe(false);
  expect(readLinearConnector(connectorId)?.user).toBeNull();
  expect(
    provider.mock.calls.every(
      ([url]) => url === "https://api.linear.app/oauth/revoke",
    ),
  ).toBe(true);
  expect(onFlash).not.toHaveBeenCalled();
});
