import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { readLinearConnector } from "@opensesame/app-core/lib/linear-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinearActions } from "./LinearActions.js";
import { LinearFlashHarness } from "./linear-flash.test-support.js";
import {
  createLinearUiConnection,
  linearUiAccount,
  linearUiResponse,
} from "./linear-ui.test-support.js";

function ActionsScope(props: { connectorId: string; onChanged?: () => void }) {
  return (
    <LinearFlashHarness>
      {(onFlash) => <LinearActions {...props} onFlash={onFlash} />}
    </LinearFlashHarness>
  );
}

const originalFetch = linearApiSeams.fetch;
let connectorId = "";
const fetcher = vi.fn<typeof linearApiSeams.fetch>();
beforeEach(async () => {
  kvForgetAll();
  clearNotices();
  connectorId = await createLinearUiConnection();
  fetcher.mockReset();
  linearApiSeams.fetch = fetcher;
});
afterEach(() => {
  cleanup();
  linearApiSeams.fetch = originalFetch;
  kvForgetAll();
  clearNotices();
});

it("awaits provider results, uses the selected actor, and renders returned issue links", async () => {
  fetcher.mockResolvedValue(
    linearUiResponse({
      issues: {
        nodes: [
          {
            id: "issue-1",
            identifier: "OS-1",
            title: "A real result",
            url: "https://linear.app/example/issue/OS-1",
          },
        ],
      },
    }),
  );
  render(<ActionsScope connectorId={connectorId} />);
  await userEvent.selectOptions(screen.getByLabelText("Act as"), "user");
  await userEvent.click(
    screen.getByRole("button", { name: "Read Linear issues" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "OS-1 · A real result" }),
    ).toHaveProperty("href", "https://linear.app/example/issue/OS-1"),
  );
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
  ).toBe("Bearer private-user-token");
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain(
    "OpenSesameIssues",
  );
});

it("refreshes the connection summary after Linear invalidates an actor", async () => {
  fetcher.mockResolvedValue(new Response("", { status: 401 }));
  const onChanged = vi.fn();
  render(<ActionsScope connectorId={connectorId} onChanged={onChanged} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Read Linear issues" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      listNotices().filter(
        (notice) =>
          notice.body ===
          "Linear authorization expired or was refused. Reconnect Linear.",
      ),
    ).toHaveLength(1),
  );
  expect(listNotices()).toHaveLength(1);
  expect(
    screen.getByRole("img", {
      name: "Linear authorization expired or was refused. Reconnect Linear.",
    }),
  ).toBeTruthy();
  expect(readLinearConnector(connectorId)?.app?.needsReauth).toBe(true);
});

it("retains issue details after a provider refusal and clears them only after creation succeeds", async () => {
  fetcher.mockResolvedValueOnce(linearUiResponse(linearUiAccount));
  fetcher.mockResolvedValueOnce(new Response("", { status: 403 }));
  render(<ActionsScope connectorId={connectorId} />);
  await userEvent.click(
    screen.getByText("Create a Linear issue", { exact: true }),
  );
  const create = screen.getByRole("button", { name: "Create issue in Linear" });
  expect(create).toHaveProperty("disabled", true);
  await userEvent.click(
    screen.getByRole("button", { name: "Load Linear teams" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Linear team")).toHaveProperty(
      "value",
      "team-1",
    ),
  );
  await userEvent.type(
    screen.getByLabelText("Issue title"),
    "Investigate connection",
  );
  await userEvent.type(
    screen.getByLabelText("Issue description"),
    "Keep this draft after errors.",
  );
  await userEvent.click(create);
  await waitFor(() =>
    expect(listNotices()[0]?.body).toContain("Linear refused this operation"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("img", { name: /Linear refused this operation/ }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Issue title")).toHaveProperty(
    "value",
    "Investigate connection",
  );
  expect(
    screen.queryByText("Issue created in Linear", { exact: true }),
  ).toBeNull();
  fetcher.mockResolvedValueOnce(
    linearUiResponse({
      issueCreate: {
        success: true,
        issue: {
          id: "issue-2",
          identifier: "ENG-2",
          title: "Investigate connection",
          description: "Keep this draft after errors.",
          url: "https://linear.app/example/issue/ENG-2",
        },
      },
    }),
  );
  await userEvent.click(create);
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "ENG-2 · Investigate connection" }),
    ).toBeTruthy(),
  );
  const created = fetcher.mock.calls.at(-1)?.[1];
  expect(JSON.parse(String(created?.body))).toMatchObject({
    variables: {
      input: {
        teamId: "team-1",
        title: "Investigate connection",
        description: "Keep this draft after errors.",
      },
    },
  });
  expect(new Headers(created?.headers).get("authorization")).toBe(
    "private-api-key",
  );
  expect(screen.getByLabelText("Issue title")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Issue description")).toHaveProperty(
    "value",
    "",
  );
  expect(listNotices()).toEqual([]);
});

it("does not reuse one actor's team selection or results after changing actors", async () => {
  fetcher.mockResolvedValue(linearUiResponse(linearUiAccount));
  render(<ActionsScope connectorId={connectorId} />);
  await userEvent.click(
    screen.getByText("Create a Linear issue", { exact: true }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Load Linear teams" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Linear team")).toBeTruthy(),
  );
  await userEvent.selectOptions(screen.getByLabelText("Act as"), "user");
  expect(
    screen.getByRole("img", {
      name: "Linear write or issues:create scope required",
    }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Linear team")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Create issue in Linear" }),
  ).toHaveProperty("disabled", true);
});

it("keeps operation names accessible on icon keys and the create commit beside its fields", async () => {
  render(<ActionsScope connectorId={connectorId} />);
  await userEvent.click(
    screen.getByText("Create a Linear issue", { exact: true }),
  );
  for (const name of [
    "Read Linear issues",
    "Read Linear projects",
    "Load Linear teams",
    "Create issue in Linear",
  ]) {
    const key = screen.getByRole("button", { name });
    expect(key.textContent?.trim()).toBe("");
    expect(key.getAttribute("title")).toBe(name);
    expect(key.querySelector("svg")).toBeTruthy();
  }
  const create = screen.getByRole("button", { name: "Create issue in Linear" });
  expect(create.className).toBe("go");
  expect(create.parentElement?.querySelector(".go-verb")?.textContent).toBe(
    "Create issue in Linear",
  );
});

it("rejects untrusted provider URLs and offers no operations without a verified actor", async () => {
  fetcher.mockResolvedValue(
    linearUiResponse({
      issues: {
        nodes: [
          {
            id: "issue-1",
            identifier: "OS-1",
            title: "Unsafe destination",
            url: "https://linear.app.attacker.example/issue",
          },
        ],
      },
    }),
  );
  const view = render(<ActionsScope connectorId={connectorId} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Read Linear issues" }),
  );
  await waitFor(() =>
    expect(listNotices()[0]?.body).toContain("Linear did not complete"),
  );
  expect(screen.queryByRole("link")).toBeNull();
  kvForgetAll();
  view.rerender(<ActionsScope connectorId={connectorId} />);
  expect(
    screen.queryByRole("button", { name: "Read Linear issues" }),
  ).toBeNull();
});
