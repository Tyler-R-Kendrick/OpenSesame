/** @vitest-environment jsdom */
import { fakeSupportPageContext } from "@opensesame/support-agent";
import { expect, it, vi } from "vitest";
import { createAgUiSupportAgent } from "./ag-ui-agent.js";
import { decideRemotePreview, remotePreviewSnapshot } from "./consent.js";

it("the default run sends nothing before exact preview consent", async () => {
  let sent = 0;
  const agent = createAgUiSupportAgent({
    endpoint: { url: "https://support.example/agui", headers: new Map() },
    online: () => true,
    transport: async function* () {
      sent++;
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "answer" };
    },
  });
  const pending = agent
    .run(
      {
        question: "password=sentinel",
        history: [],
        context: fakeSupportPageContext(),
      },
      { signal: new AbortController().signal },
    )
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(remotePreviewSnapshot()).not.toBeNull());
  expect(sent).toBe(0);
  const preview = remotePreviewSnapshot();
  expect(JSON.stringify(preview)).not.toContain("sentinel");
  decideRemotePreview(preview?.id ?? 0, true);
  expect(await pending).toMatchObject({ answer: "answer", guide: null });
  expect(sent).toBe(1);
  expect(remotePreviewSnapshot()).toBeNull();
});
