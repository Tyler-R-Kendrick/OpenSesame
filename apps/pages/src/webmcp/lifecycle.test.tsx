/** @vitest-environment jsdom */
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindWebMcpSupport,
  registerBootTools,
  registerSessionTools,
  useWebMcp,
} from "./lifecycle.js";
import {
  resetWebMcpRegistrationForTests,
  webmcpRegistrationSnapshot,
} from "./registration.js";
import { WEBMCP_TOOLS, webmcpNavigationSeam } from "./tools.js";

type RegisteredTool = {
  name: string;
  execute: (args: JsonObject) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
};

function dropModelContext(): void {
  Reflect.deleteProperty(overlapCast(window.navigator), "modelContext");
}

function stubModelContext() {
  const tools: RegisteredTool[] = [];
  const modelContext = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
      return () => {
        tools.splice(tools.indexOf(tool), 1);
      };
    },
  };
  Object.defineProperty(window.navigator, "modelContext", {
    value: modelContext,
    configurable: true,
  });
  return { tools, restore: dropModelContext };
}

const BOOT_NAMES = WEBMCP_TOOLS.filter((t) => t.scope === "boot").map(
  (t) => t.name,
);
const SESSION_NAMES = WEBMCP_TOOLS.filter((t) => t.scope === "session").map(
  (t) => t.name,
);

/**
 * The current draft, on `document`: `registerTool` answers with a promise,
 * rejects a name it already holds, has no `unregisterTool`, and drops a tool
 * only when the signal handed to `registerTool` aborts.
 */
function stubDraftModelContext() {
  const tools = new Map<string, RegisteredTool>();
  const rejected: string[] = [];
  let registrations = 0;
  const modelContext = {
    registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
      registrations += 1;
      if (tools.has(tool.name)) {
        rejected.push(tool.name);
        return Promise.reject(new Error("InvalidStateError: duplicate"));
      }
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => {
        tools.delete(tool.name);
      });
      return Promise.resolve(undefined);
    },
    getTools() {
      return Promise.resolve([...tools.values()]);
    },
  };
  Object.defineProperty(document, "modelContext", {
    value: modelContext,
    configurable: true,
  });
  return {
    tools,
    rejected,
    registrations: () => registrations,
    restore: () => {
      Reflect.deleteProperty(overlapCast(document), "modelContext");
    },
  };
}

afterEach(() => {
  cleanup();
  dropModelContext();
  Reflect.deleteProperty(overlapCast(document), "modelContext");
  resetWebMcpRegistrationForTests();
});

describe("registerBootTools / registerSessionTools", () => {
  it("no-ops without navigator.modelContext", () => {
    const unregister = registerBootTools({ navigate: () => {} });
    expect(unregister).toBeInstanceOf(Function);
    unregister();
  });

  it("registers boot tools, binds the router seam and restores it", async () => {
    const { tools, restore } = stubModelContext();
    const navigate = vi.fn();
    const unregister = registerBootTools({ navigate });
    expect(tools.map((t) => t.name)).toEqual(BOOT_NAMES);

    const navTool = tools.find((t) => t.name === "opensesame_navigate");
    const result = await navTool?.execute({ section: "/settings" });
    expect(navigate).toHaveBeenCalledWith("/settings");
    expect(result?.content[0]?.text).toContain('"status":"navigated"');
    expect(result?.isError).toBeUndefined();

    unregister();
    expect(tools).toHaveLength(0);
    webmcpNavigationSeam.navigate("/vault");
    expect(navigate).toHaveBeenCalledTimes(1);
    restore();
  });

  it("registers the seventeen session tools and unregisters them", () => {
    const { tools, restore } = stubModelContext();
    const unregister = registerSessionTools();
    expect(tools.map((t) => t.name)).toEqual(SESSION_NAMES);
    expect(tools).toHaveLength(17);
    unregister();
    expect(tools).toHaveLength(0);
    restore();
  });

  it("fences tool errors instead of throwing across the boundary", async () => {
    const { tools, restore } = stubModelContext();
    const unregister = registerBootTools({ navigate: () => {} });
    const navTool = tools.find((t) => t.name === "opensesame_navigate");
    const result = await navTool?.execute({ section: "nowhere" });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("unknown_section");
    unregister();
    restore();
  });
});

describe("bindWebMcpSupport", () => {
  it("routes the guidance tools at the mounted panel and lets go of it", async () => {
    const { tools, restore } = stubModelContext();
    const opened: (string | null)[] = [];
    const started: string[] = [];
    const unregister = registerSessionTools();
    const unbind = bindWebMcpSupport({
      openSupport: (topic) => {
        opened.push(topic);
      },
      startGuide: (goal) => {
        started.push(goal);
      },
    });

    const help = tools.find((t) => t.name === "opensesame_help");
    const guide = tools.find((t) => t.name === "opensesame_guide_start");
    await help?.execute({ topic: "help.lock" });
    await guide?.execute({ goal: "vault.lock" });
    expect(opened).toEqual(["help.lock"]);
    expect(started).toEqual(["vault.lock"]);

    unbind();
    const after = await help?.execute({});
    expect(after?.isError).toBeUndefined();
    expect(opened).toEqual(["help.lock"]);

    unregister();
    restore();
  });

  it("leaves the tools callable and refusing with no panel bound", async () => {
    const { tools, restore } = stubModelContext();
    const unregister = registerSessionTools();
    const guide = tools.find((t) => t.name === "opensesame_guide_start");
    const refused = await guide?.execute({ goal: 'focus "#x" "y"' });
    expect(refused?.isError).toBe(true);
    expect(refused?.content[0]?.text).toContain("unknown_guide_goal");
    unregister();
    restore();
  });
});

describe("useWebMcp", () => {
  function Probe({ status }: { status: string }) {
    useWebMcp(status);
    return null;
  }

  it("keeps boot tools mounted and gates session tools on unlock", () => {
    const { tools, restore } = stubModelContext();
    const view = render(
      <MemoryRouter>
        <Probe status="locked" />
      </MemoryRouter>,
    );
    expect(tools.map((t) => t.name)).toEqual(BOOT_NAMES);

    view.rerender(
      <MemoryRouter>
        <Probe status="unlocked" />
      </MemoryRouter>,
    );
    expect(tools.map((t) => t.name)).toEqual([...BOOT_NAMES, ...SESSION_NAMES]);

    view.rerender(
      <MemoryRouter>
        <Probe status="locked" />
      </MemoryRouter>,
    );
    expect(tools.map((t) => t.name)).toEqual(BOOT_NAMES);

    view.unmount();
    expect(tools).toHaveLength(0);
    restore();
  });

  it("keeps the boot tools registered across route changes, never re-registering", () => {
    const draft = stubDraftModelContext();
    const view = render(
      <MemoryRouter initialEntries={["/vault"]}>
        <Probe status="locked" />
      </MemoryRouter>,
    );
    expect([...draft.tools.keys()]).toEqual(BOOT_NAMES);
    const after = draft.registrations();

    view.rerender(
      <MemoryRouter initialEntries={["/identity"]}>
        <Probe status="locked" />
      </MemoryRouter>,
    );
    view.rerender(
      <MemoryRouter initialEntries={["/settings"]}>
        <Probe status="unlocked" />
      </MemoryRouter>,
    );
    expect(draft.rejected).toEqual([]);
    expect([...draft.tools.keys()]).toEqual([...BOOT_NAMES, ...SESSION_NAMES]);
    expect(draft.registrations()).toBe(after + SESSION_NAMES.length);

    const snapshot = webmcpRegistrationSnapshot();
    expect(snapshot.source).toBe("document");
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.implemented.map((tool) => tool.name)).toEqual([
      ...BOOT_NAMES,
      ...SESSION_NAMES,
    ]);

    view.unmount();
    // Every registration ended through its abort signal — the draft has no
    // other way, and this is the path the old handle-based code never took.
    expect(draft.tools.size).toBe(0);
    expect(webmcpRegistrationSnapshot().implemented).toEqual([]);
    draft.restore();
  });

  it("records what a browser without a model context would have received", () => {
    const view = render(
      <MemoryRouter>
        <Probe status="unlocked" />
      </MemoryRouter>,
    );
    const snapshot = webmcpRegistrationSnapshot();
    expect(snapshot.source).toBeNull();
    expect(snapshot.implemented).toHaveLength(
      BOOT_NAMES.length + SESSION_NAMES.length,
    );
    view.unmount();
  });

  it("records a registration the browser refused", async () => {
    const draft = stubDraftModelContext();
    draft.tools.set("opensesame_status", {
      name: "opensesame_status",
      execute: () => Promise.resolve({ content: [] }),
    });
    const view = render(
      <MemoryRouter>
        <Probe status="locked" />
      </MemoryRouter>,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(webmcpRegistrationSnapshot().failures).toEqual([
      { name: "opensesame_status", reason: "InvalidStateError: duplicate" },
    ]);
    view.unmount();
    draft.restore();
  });

  it("renders without WebMCP support present", () => {
    const view = render(
      <MemoryRouter>
        <Probe status="unlocked" />
      </MemoryRouter>,
    );
    view.unmount();
  });
});
