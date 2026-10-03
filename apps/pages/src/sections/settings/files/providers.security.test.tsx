/** @vitest-environment jsdom */
import { kvDelete, kvGet } from "@opensesame/app-core/lib/kv.js";
import { TRAVEL_SAFE_KEY } from "@opensesame/app-core/lib/travel/safe-flags.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { useCategoryFiles } from "./providers.js";

const TRAVEL = "settings/security/travel/safe.json";
const DURESS = "settings/security/duress/status.json";
const originalHooks = { ...vaultHooksSeams };

function session(status: "unlocked" | "locked", guest: boolean) {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), status, guest }),
  });
}

describe("Security's files in Settings' viewer (ADR 0134)", () => {
  beforeEach(() => kvDelete(TRAVEL_SAFE_KEY));
  afterEach(() => Object.assign(vaultHooksSeams, originalHooks));

  it("lists the travel and duress files to the owner of an open vault", async () => {
    session("unlocked", false);
    const { result } = renderHook(() => useCategoryFiles("security"));
    const files = result.current;
    expect(files?.list().map((file) => file.path)).toEqual([TRAVEL, DURESS]);
    expect(files?.list().find((file) => file.path === DURESS)?.readOnly).toBe(
      true,
    );
    expect(JSON.parse((await files?.read(DURESS)) ?? "null")).toMatchObject({
      armed: false,
    });
  });

  it("writes a mark through the Travel sheet's store", async () => {
    session("unlocked", false);
    const { result } = renderHook(() => useCategoryFiles("security"));
    const outcome = await result.current?.write(
      TRAVEL,
      '{"safe":["personal"]}',
    );
    expect(outcome?.ok).toBe(true);
    expect(JSON.parse(kvGet(TRAVEL_SAFE_KEY) ?? "null")).toEqual({
      safe: ["personal"],
    });
  });

  it("draws no file for a guest or a locked device", () => {
    for (const [status, guest] of [
      ["unlocked", true],
      ["locked", false],
    ] as const) {
      session(status, guest);
      const { result } = renderHook(() => useCategoryFiles("security"));
      expect(result.current).toBeNull();
    }
  });

  it("is one provider across renders", () => {
    session("unlocked", false);
    const { result, rerender } = renderHook(() => useCategoryFiles("security"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
