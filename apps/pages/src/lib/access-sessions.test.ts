import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccessSession } from "./access-sessions.js";
import { identitySeams } from "./identity.js";

beforeEach(() => {
  vi.spyOn(identitySeams, "hostBase").mockReturnValue("https://host.example");
});
afterEach(() => vi.restoreAllMocks());

it("derives session ownership from Host identity and posts only an explicit ceiling", async () => {
  const fetch = vi
    .spyOn(identitySeams, "hostFetch")
    .mockResolvedValueOnce(
      Response.json({ principal_id: "principal-1", organization_id: "org-1" }),
    )
    .mockResolvedValueOnce(
      Response.json({
        task_run_id: "task-1",
        state_version: 1,
        status: "active",
      }),
    );
  const capabilities = [{ action: "read", resource: "repo:owned" }];
  expect(await createAccessSession(capabilities, 900)).toEqual({
    taskRunId: "task-1",
    stateVersion: 1,
    status: "active",
  });
  expect(fetch.mock.calls[1]).toEqual([
    "/api/v1/tasks",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        principal_id: "principal-1",
        organization_id: "org-1",
        capabilities,
        ttl_seconds: 900,
      }),
    }),
  ]);
});

it.each([0, 86401, 1.5, Number.NaN])(
  "rejects invalid lifetime %s before any network request",
  async (ttl) => {
    const fetch = vi.spyOn(identitySeams, "hostFetch");
    await expect(
      createAccessSession([{ action: "read", resource: "owned" }], ttl),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("refuses missing scope and malformed Host identity", async () => {
  const fetch = vi
    .spyOn(identitySeams, "hostFetch")
    .mockResolvedValue(Response.json({ principal_id: "principal-1" }));
  await expect(createAccessSession([], 900)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    createAccessSession([{ action: "read", resource: "owned" }], 900),
  ).rejects.toThrow("Authenticate");
  expect(fetch).toHaveBeenCalledTimes(1);
});
