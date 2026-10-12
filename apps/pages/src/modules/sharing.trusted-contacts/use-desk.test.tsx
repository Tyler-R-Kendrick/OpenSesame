import { TRUSTED_CIRCLE_TYPE } from "@opensesame/app-core/lib/quorum/records.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
/**
 * The desk a panel stands on, against the real vault store: absent while the
 * vault is locked, empty, a guest or a decoy, and for an open vault one set of
 * ports whose records follow the vault as it changes.
 */
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
import type { TypedItem } from "@opensesame/vault-core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  deskSeams,
  realUseDesk,
  useDesk,
  useUnreadableRecords,
} from "./use-desk.js";
import {
  PASSWORD,
  clearPersonalTomb,
  records,
} from "./vault-records.test-support.js";

const seams = { ...vaultHooksSeams };

beforeEach(async () => {
  await clearPersonalTomb();
});

afterEach(async () => {
  cleanup();
  Object.assign(vaultHooksSeams, seams);
  deskSeams.useDesk = realUseDesk;
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await vaultStore.destroy();
});

const open = () => act(() => vaultStore.create(PASSWORD));

describe("useDesk", () => {
  it("is the real desk until a test replaces it", () => {
    expect(deskSeams.useDesk).toBe(realUseDesk);
    const { result } = renderHook(() => useDesk());
    expect(result.current).toBeNull();
  });

  it("is absent before a vault exists, and again once it locks", async () => {
    const { result } = renderHook(() => useDesk());
    expect(vaultStore.getSnapshot().status).toBe("empty");
    expect(result.current).toBeNull();
    await open();
    expect(result.current).not.toBeNull();
    act(() => vaultStore.lock());
    expect(vaultStore.getSnapshot().status).toBe("locked");
    expect(result.current).toBeNull();
  });

  it("is absent in a guest session", async () => {
    await act(() => vaultStore.createGuest());
    expect(vaultStore.getSnapshot().guest).toBe(true);
    const { result } = renderHook(() => useDesk());
    expect(result.current).toBeNull();
  });

  it("is absent for a decoy, and where the vault names no tomb", async () => {
    await open();
    const { result, rerender } = renderHook(() => useDesk());
    expect(result.current).not.toBeNull();

    // The real hook underneath, so the order of hooks does not change.
    vaultHooksSeams.useVault = () => ({
      ...seams.useVault(),
      guest: false,
      decoy: true,
    });
    rerender();
    expect(result.current).toBeNull();

    vaultHooksSeams.useVault = () => ({ ...seams.useVault(), tomb: "" });
    rerender();
    expect(result.current).toBeNull();
  });

  it("hands one set of ports to everything that asks for an open vault, across renders", async () => {
    await open();
    const first = renderHook(() => useDesk());
    const second = renderHook(() => useDesk());
    const ports = first.result.current?.ports;
    expect(ports).toBeDefined();
    expect(second.result.current?.ports).toBe(ports);
    first.rerender();
    await act(() => vaultStore.addFolder("Anything that changes the vault"));
    expect(first.result.current?.ports).toBe(ports);
    expect(second.result.current?.ports).toBe(ports);
  });

  it("describes this page, this vault and the clock", async () => {
    await open();
    const { result } = renderHook(() => useDesk());
    const ports = result.current?.ports;
    expect(ports?.origin).toBe(window.location.origin);
    expect(ports?.rpId).toBe(window.location.hostname);
    expect(ports?.tomb).toBe(PERSONAL_TOMB);
    const before = Date.now();
    expect(ports?.now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it("looks for the page's keys when one is touched, not when the desk is made", async () => {
    await open();
    const { result } = renderHook(() => useDesk());
    expect(result.current).not.toBeNull();
    // This page has no credentials container: the step that needs one says so.
    await expect(
      result.current?.ports.ceremony.assert({
        rpId: window.location.hostname,
        challenge: new Uint8Array(32),
        allowCredentialIds: [],
        requireUserVerification: false,
      }),
    ).rejects.toThrow();
  });

  it("lists the records of the vault, and follows them as they are saved and removed", async () => {
    const { owned, share, seat } = await records();
    await open();
    const { result } = renderHook(() => useDesk());
    expect(result.current?.owned).toEqual([]);
    expect(result.current?.held).toEqual([]);
    const ports = result.current?.ports;
    if (!ports) throw new Error("no desk");

    await act(() => ports.records.saveOwned(owned));
    expect(result.current?.owned.map((r) => r.signedPolicy.digest)).toEqual([
      owned.signedPolicy.digest,
    ]);

    await act(() => ports.records.saveHeld(share));
    await act(() => ports.records.saveHeld(seat));
    expect(result.current?.held).toHaveLength(2);

    await act(() => ports.records.saveOwned({ ...owned, state: "armed" }));
    expect(result.current?.owned.map((r) => r.state)).toEqual(["armed"]);

    await act(() =>
      ports.records.removeHeld(share.seat.signedPolicy.policy.circleId),
    );
    expect(result.current?.held.map((r) => r.seat.guardianId)).toEqual([
      seat.seat.guardianId,
    ]);
    await act(() =>
      ports.records.removeOwned(owned.signedPolicy.policy.circleId),
    );
    expect(result.current?.owned).toEqual([]);
  });

  it("reads again on refresh, and the ports do not change", async () => {
    const { owned } = await records();
    await open();
    const { result } = renderHook(() => useDesk());
    const ports = result.current?.ports;
    if (!ports) throw new Error("no desk");
    await act(() => ports.records.saveOwned(owned));
    await act(() => result.current?.refresh() ?? Promise.resolve());
    expect(result.current?.owned).toHaveLength(1);
    expect(result.current?.ports).toBe(ports);
  });

  it("keeps its list when something else in the vault changes", async () => {
    const { owned } = await records();
    await open();
    const { result } = renderHook(() => useDesk());
    await act(
      () => result.current?.ports.records.saveOwned(owned) ?? Promise.resolve(),
    );
    const [kept] = result.current?.owned ?? [];
    await act(() => vaultStore.addFolder("Elsewhere"));
    expect(result.current?.owned[0]?.signedPolicy.digest).toBe(
      kept?.signedPolicy.digest,
    );
  });
});

describe("useUnreadableRecords", () => {
  it("names a circle that no longer verifies, and nothing without a desk", async () => {
    const { owned } = await records();
    const absent = renderHook(() => useUnreadableRecords());
    expect(absent.result.current).toEqual([]);

    await open();
    const desk = renderHook(() => useDesk());
    const { result } = renderHook(() => useUnreadableRecords());
    await act(
      () =>
        desk.result.current?.ports.records.saveOwned(owned) ??
        Promise.resolve(),
    );
    expect(result.current).toEqual([]);

    const item = vaultStore
      .getSnapshot()
      .items.find(
        (i): i is TypedItem =>
          i.kind === "typed" && i.typeId === TRUSTED_CIRCLE_TYPE,
      );
    if (!item) throw new Error("not saved");
    await act(() =>
      vaultStore.saveItem({ ...item, values: { ...item.values, policy: "?" } }),
    );
    expect(result.current).toMatchObject([
      {
        type: "owned",
        name: owned.signedPolicy.policy.label,
        reason: "format",
      },
    ]);
    expect(desk.result.current?.owned).toEqual([]);

    act(() => vaultStore.lock());
    expect(result.current).toEqual([]);
  });
});
