import { afterEach, beforeEach, expect, it } from "vitest";
import { updateNativeConnector } from "../native-connector-store.js";
import { nativeOAuthGuard } from "../native-oauth-session.js";
import { createProject, setActiveProject } from "../projects.js";
import { deferred } from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import {
  aiDelegationAvailable,
  executeAiDelegatedRequest,
} from "./delegation.js";
import {
  canonicalCall,
  canonicalDraft,
  delegatedAnswer,
  delegationFence,
  delegationFixture,
} from "./delegation.test-support.js";
import { saveAiConnection } from "./runtime.js";
import { AI_CONNECTION_CLASSIFICATION, aiConnectionRecord } from "./store.js";

let fixture: Awaited<ReturnType<typeof delegationFixture>>;
beforeEach(async () => {
  fixture = await delegationFixture();
});
afterEach(async () => {
  await fixture.close();
});
async function execute(id: string) {
  const call = canonicalCall();
  return executeAiDelegatedRequest(
    id,
    call.definition,
    call.body,
    (value) => value,
    delegationFence(),
  );
}

it.each(["edited", "trashed", "deleted", "unverified"])(
  "a %s actual vault key cannot back admission or another delegated request",
  async (kind) => {
    const id = await fixture.save();
    const item = vaultStore.getSnapshot().items[0];
    if (!item || item.kind !== "credential" || item.method.type !== "token")
      throw new Error("Expected real Token credential");
    if (kind === "edited")
      await vaultStore.saveItem({
        ...item,
        method: { ...item.method, token: "unverified-user-edited-token" },
      });
    if (kind === "trashed" || kind === "deleted")
      await vaultStore.trashItem(item.id);
    if (kind === "deleted") await vaultStore.purgeItem(item.id);
    if (kind === "unverified") {
      const record = aiConnectionRecord(id);
      if (!record) throw new Error("Expected record");
      await updateNativeConnector(
        id,
        nativeOAuthGuard(record),
        AI_CONNECTION_CLASSIFICATION,
        (current) => {
          current.privateState.verification = null;
          return current;
        },
      );
    }
    expect(aiDelegationAvailable(id)).toBe(false);
    await expect(execute(id)).rejects.toThrow();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

it("never resolves a canonical credential from a different real vault", async () => {
  const id = await fixture.save();
  const project = await createProject("Delegation isolation vault");
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.create("another-real-vault-password");
  expect(vaultStore.getSnapshot().tomb).toBe(project.id);
  expect(aiDelegationAvailable(id)).toBe(false);
  await expect(execute(id)).rejects.toThrow();
  expect(fixture.fetcher).not.toHaveBeenCalled();
  await setActiveProject("personal");
  vaultStore.loadActiveProjectScope();
});

it("a lock, aborted application fence or disposed connector transport stops dispatch", async () => {
  const id = await fixture.save();
  const call = canonicalCall();
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    executeAiDelegatedRequest(
      id,
      call.definition,
      call.body,
      (value) => value,
      { ...delegationFence(), signal: aborted.signal },
    ),
  ).rejects.toThrow();
  fixture.lifetime.abort();
  await expect(execute(id)).rejects.toThrow();
  vaultStore.lock();
  expect(aiDelegationAvailable(id)).toBe(false);
  await expect(execute(id)).rejects.toThrow();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it("configuration changes during a request reject the result and old keys cannot spend another request", async () => {
  const id = await fixture.save();
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.fetcher.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return Response.json(delegatedAnswer("openai"));
  });
  const pending = execute(id);
  const failure = expect(pending).rejects.toThrow();
  await entered.promise;
  const record = aiConnectionRecord(id);
  if (!record) throw new Error("Expected record");
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    AI_CONNECTION_CLASSIFICATION,
    (current) => {
      current.configuration.parameters.base_url = "https://foreign.example/v1";
      return current;
    },
  );
  resume.resolve();
  await failure;
  expect(aiDelegationAvailable(id)).toBe(false);
  await expect(execute(id)).rejects.toThrow();
  expect(fixture.fetcher).toHaveBeenCalledTimes(1);
});

it("an actual 401 ends native verification, while a late 401 cannot invalidate a newly verified replacement", async () => {
  const id = await fixture.save();
  fixture.fetcher.mockImplementationOnce(
    async () => new Response(null, { status: 401 }),
  );
  await expect(execute(id)).rejects.toMatchObject({ code: "authorization" });
  expect(aiDelegationAvailable(id)).toBe(false);
  await saveAiConnection(canonicalDraft(), id);
  fixture.fetcher.mockClear();
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.fetcher.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return new Response(null, { status: 401 });
  });
  const pending = execute(id);
  const failure = expect(pending).rejects.toThrow();
  await entered.promise;
  await saveAiConnection(
    { ...canonicalDraft(), apiKey: "newly-verified-replacement-key" },
    id,
  );
  resume.resolve();
  await failure;
  expect(aiDelegationAvailable(id)).toBe(true);
  fixture.fetcher.mockClear();
  await execute(id);
  expect(
    new Headers(fixture.fetcher.mock.calls[0]?.[1]?.headers).get(
      "authorization",
    ),
  ).toBe("Bearer newly-verified-replacement-key");
});
