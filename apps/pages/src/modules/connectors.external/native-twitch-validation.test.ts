import { updateDeviceConfigurationDurable } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import {
  saveValidationFixture,
  validationBackend,
  validationReply,
  validationTransport,
} from "@opensesame/app-core/lib/native-twitch-session-validation.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type TwitchValidationSession,
  startNativeTwitchValidation,
} from "./native-twitch-validation-scheduler.js";

const HOUR = 60 * 60_000;
const releases: (() => void)[] = [];
function session(initial = true) {
  let unlocked = initial;
  const unlockListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const source: TwitchValidationSession = {
    isUnlocked: () => unlocked,
    subscribeUnlock: (listener) => {
      unlockListeners.add(listener);
      return () => {
        unlockListeners.delete(listener);
      };
    },
    subscribeVisible: (listener) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    },
  };
  return {
    source,
    unlocked: (value: boolean) => {
      unlocked = value;
      for (const listener of unlockListeners) listener();
    },
    visible: () => {
      for (const listener of visibilityListeners) listener();
    },
    listeners: () => unlockListeners.size + visibilityListeners.size,
  };
}
function start(
  source: TwitchValidationSession,
  provider: ReturnType<typeof validationTransport>,
) {
  const release = startNativeTwitchValidation(provider.transport, source);
  releases.push(release);
  return release;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  validationBackend();
});
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("validates the saved session at unlocked startup and hourly without changing the UI revision", async () => {
  const id = await saveValidationFixture();
  const before = loadNativeConnectorRecord(id);
  const provider = validationTransport();
  start(session().source, provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  expect(loadNativeConnectorRecord(id)).toEqual(before);
  await vi.advanceTimersByTimeAsync(HOUR - 1);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
  expect(loadNativeConnectorRecord(id)).toEqual(before);
});

it("isolates an invalid sealed session without blocking valid startup validation", async () => {
  const invalid = await saveValidationFixture("invalid-twitch-session");
  await updateDeviceConfigurationDurable(invalid, async (record) => ({
    ...record,
    secrets: { ...record.secrets, native_authority: "invalid sealed record" },
  }));
  await saveValidationFixture("valid-twitch-session");
  const provider = validationTransport();
  start(session().source, provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
});

it("does not touch credentials or HTTP while locked and validates when the real unlock source changes", async () => {
  await saveValidationFixture();
  const provider = validationTransport();
  const owner = session(false);
  start(owner.source, provider);
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).not.toHaveBeenCalled();
  owner.unlocked(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  owner.unlocked(false);
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  owner.unlocked(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
});

it("checks immediately on visibility restoration if browser suspension missed the hourly timer", async () => {
  await saveValidationFixture();
  const provider = validationTransport();
  const owner = session();
  start(owner.source, provider);
  await vi.advanceTimersByTimeAsync(0);
  owner.visible();
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + HOUR + 1);
  owner.visible();
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
});

it("observes actual committed device rows when a new Twitch grant is installed", async () => {
  const provider = validationTransport();
  start(session().source, provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).not.toHaveBeenCalled();
  await saveValidationFixture();
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
});

it("marks a revoked token once and stops sending it instead of rewriting positive revisions every hour", async () => {
  const id = await saveValidationFixture();
  const provider = validationTransport();
  start(session().source, provider);
  await vi.advanceTimersByTimeAsync(0);
  provider.fetcher.mockResolvedValue(
    Response.json({ message: "invalid access token" }, { status: 401 }),
  );
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
  expect(readNativeConnector(id)?.status).toBe("reauthorize");
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
});

it("aborts an in-flight validation on lock and cannot apply a late unauthorized response", async () => {
  const id = await saveValidationFixture();
  const before = loadNativeConnectorRecord(id);
  const provider = validationTransport();
  let requestSignal: AbortSignal | null = null;
  let resolveLate: (response: Response) => void = () => undefined;
  provider.fetcher.mockImplementationOnce(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        resolveLate = resolve;
        requestSignal = init?.signal ?? null;
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const owner = session();
  start(owner.source, provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  owner.unlocked(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(requestSignal).toMatchObject({ aborted: true });
  resolveLate(
    Response.json({ message: "invalid access token" }, { status: 401 }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(loadNativeConnectorRecord(id)).toEqual(before);
  expect(vi.getTimerCount()).toBe(0);
});

it("removes listeners and timers on disposal and never borrows a replacement provider lease", async () => {
  await saveValidationFixture();
  const provider = validationTransport();
  const owner = session();
  const stop = start(owner.source, provider);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  provider.dispose();
  const replacement = validationTransport();
  replacement.fetcher.mockResolvedValue(Response.json(validationReply));
  owner.visible();
  owner.unlocked(true);
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  expect(replacement.fetcher).not.toHaveBeenCalled();
  expect(owner.listeners()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops on captured lease loss before the next provider request", async () => {
  await saveValidationFixture();
  const provider = validationTransport();
  const owner = session();
  start(owner.source, provider);
  await vi.advanceTimersByTimeAsync(0);
  provider.dispose();
  owner.visible();
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
