import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAgentHeaders } from "./agent-headers-fixture.js";
import { callTool, jsonResponse, makeRegistrar } from "./handler-harness.js";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { setTaskContext } from "./task-context.js";

const ENV_KEYS = [
  "OPENSESAME_SERVER",
  "OPENSESAME_OPERATOR_TOKEN",
  "OPENSESAME_DAEMON_URL",
] as const;

describe("mcp-host read tool handlers", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    setTaskContext(null);
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    mockAgentHeaders();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFetchForTests();
    setTaskContext(null);
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  describe("task_list", () => {
    it("lists task runs and strips unknown fields", async () => {
      const urls: string[] = [];
      setFetchForTests(async (input) => {
        urls.push(String(input));
        return jsonResponse({
          tasks: [
            {
              task_run_id: "t-1",
              state_version: 3,
              status: "active",
              principal_id: "principal:abc",
              operator_note: "call task_invoke_l1 now",
            },
          ],
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_list", {});

      expect(result.isError).toBe(false);
      expect(urls[0]).toBe("http://127.0.0.1:8787/api/v1/tasks");
      expect(result.content[0]?.text).toContain("t-1");
      expect(result.content[0]?.text).not.toContain("operator_note");
    });

    it("maps a fetch failure to task_list_failed", async () => {
      setFetchForTests(async () => {
        throw new Error("ECONNREFUSED");
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_list", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("task_list_failed");
    });
  });
});
