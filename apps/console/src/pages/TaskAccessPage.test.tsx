import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { type ReactElement, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAccessPage } from "./TaskAccessPage.js";

(
  overlapCast(globalThis)
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function renderAt(entry: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ui: ReactElement = (
    <MemoryRouter initialEntries={[entry]}>
      <TaskAccessPage />
    </MemoryRouter>
  );
  await act(async () => {
    root.render(ui);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#task-run-id");
  if (!input) throw new Error("task run id input not rendered");
  return input;
}

function inspectButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.primary");
  if (!button) throw new Error("inspect button not rendered");
  return button;
}

async function submit(): Promise<void> {
  const form = container.querySelector("form");
  if (!form) throw new Error("inspect form not rendered");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function taskBody() {
  return {
    task_run_id: "task-abc",
    state_version: 4,
    status: "active",
    capability_ceiling: [
      { action: "read", resource: "repo:a" },
      { action: "write", resource: "repo:a" },
    ],
    current_capabilities: [{ action: "read", resource: "repo:a" }],
  };
}

function jsonResponse(status: number, body: BoundaryValue = {}): Response {
  return overlapCast({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("TaskAccessPage", () => {
  it("prompts for a task run id when the URL has none", async () => {
    await renderAt("/task-access");
    expect(container.textContent).toContain("Enter a task run id");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an empty inspection without navigating", async () => {
    await renderAt("/task-access");
    await type(field(), "   ");
    await submit();
    expect(container.textContent).toContain("Enter a task run id to inspect.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads the task named in the URL and compares ceiling to current", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, taskBody()));
    await renderAt("/task-access?task=task-abc");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/v1/tasks/task-abc",
      { headers: {} },
    );
    expect(container.textContent).toContain("task-abc");
    expect(container.textContent).toContain("Ceiling");
    expect(container.textContent).toContain("read → repo:a");
    expect(field().value).toBe("task-abc");
  });

  it("navigates to the typed id, encoding it for the Host API", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, taskBody()));
    await renderAt("/task-access");
    await type(field(), "task with spaces");
    await submit();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/v1/tasks/task%20with%20spaces",
      { headers: {} },
    );
    expect(container.textContent).toContain("Ceiling");
  });

  it("submits through the inspect button as well", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, taskBody()));
    await renderAt("/task-access");
    await type(field(), "task-abc");
    await click(inspectButton());
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/v1/tasks/task-abc",
      { headers: {} },
    );
  });

  it("explains when no task matches the id", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404));
    await renderAt("/task-access?task=nope");
    expect(container.textContent).toContain("No task found for that id.");
  });

  it("explains when the Host API denies the request", async () => {
    for (const status of [401, 403]) {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(status));
      await renderAt(`/task-access?task=task-${status}`);
      expect(container.textContent).toContain(
        "Host API denied this request. Sign in or pass an operator session.",
      );
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.mocked(fetch).mockClear();
    }
  });

  it("reports the status for any other Host API failure", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(500));
    await renderAt("/task-access?task=task-abc");
    expect(container.textContent).toContain(
      "Host API could not load this task (500).",
    );
  });

  it("surfaces a non-Error rejection as text", async () => {
    vi.mocked(fetch).mockRejectedValue("offline");
    await renderAt("/task-access?task=task-abc");
    expect(container.textContent).toContain("offline");
  });

  it("shows a loading indicator while the Host API answers", async () => {
    let release: (res: Response) => void = () => {};
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await renderAt("/task-access?task=task-abc");
    expect(container.textContent).toContain("Loading task from Host API…");
    expect(inspectButton().disabled).toBe(true);
    release(jsonResponse(200, taskBody()));
    await act(async () => {});
    expect(container.textContent).toContain("Ceiling");
    expect(inspectButton().disabled).toBe(false);
  });

  it("ignores a response that arrives after the task changed", async () => {
    let first: (res: Response) => void = () => {};
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            first = resolve;
          }),
      )
      .mockResolvedValue(jsonResponse(200, taskBody()));
    await renderAt("/task-access?task=task-stale");
    // Move on before the first request resolves; its result must be dropped.
    await type(field(), "task-fresh");
    await submit();
    expect(container.textContent).toContain("Ceiling");
    first(jsonResponse(200, { task_run_id: "task-stale" }));
    await act(async () => {});
    expect(container.textContent).not.toContain("task-stale");
  });
});
