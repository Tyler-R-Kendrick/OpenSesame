/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { DeskError } from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  AssertionError,
  PacketError,
  RecoveryError,
} from "@opensesame/app-core/lib/quorum/index.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Attempt,
  GENERIC_FAILURE,
  KEY_NOT_USED,
  failureText,
  sentence,
  useCeremonyFailure,
} from "./failure-text.js";

afterEach(() => {
  cleanup();
  clearNotices();
});

describe("failureText", () => {
  it("passes the engine's own refusals through as sentences", () => {
    expect(
      failureText(
        new PacketError(
          "checksum",
          "this packet was cut off or changed on the way",
        ),
      ),
    ).toBe("This packet was cut off or changed on the way.");
    expect(failureText(new DeskError("no_recovery", "No such recovery."))).toBe(
      "No such recovery.",
    );
    expect(
      failureText(
        new AssertionError("user_presence", "the key was not touched"),
      ),
    ).toBe("The key was not touched.");
    expect(
      failureText(
        new RecoveryError("bad_release", "a release was damaged", ["g1"]),
      ),
    ).toBe("A release was damaged.");
  });

  it("says a dismissed key prompt in one sentence", () => {
    const refused = new Error(
      "The operation either timed out or was not allowed.",
    );
    refused.name = "NotAllowedError";
    expect(failureText(refused)).toBe(KEY_NOT_USED);
  });

  it("never lets an internal message reach a notice", () => {
    expect(failureText(new Error("wrapped share 0xdeadbeef failed"))).toBe(
      GENERIC_FAILURE,
    );
    expect(failureText(new TypeError("x is not a function"))).toBe(
      GENERIC_FAILURE,
    );
  });

  it("words an empty message and a fragment", () => {
    expect(sentence("  ")).toBe(GENERIC_FAILURE);
    expect(sentence("not here.")).toBe("Not here.");
    expect(sentence("Is it?")).toBe("Is it?");
  });
});

describe("useCeremonyFailure", () => {
  it("keeps the sentence for the control's mark and one notice in the tray", async () => {
    const { result } = renderHook(() =>
      useCeremonyFailure("tc:test", "Trusted contacts"),
    );
    expect(result.current.message).toBe("");
    const failed: Attempt<number>[] = [];
    await act(async () => {
      failed.push(
        await result.current.run<number>(async () => {
          throw new DeskError("kind", "this is an invite, not an enrollment");
        }),
      );
    });
    expect(failed).toEqual([{ ok: false }]);
    expect(result.current.message).toBe(
      "This is an invite, not an enrollment.",
    );
    const notice = listNotices().find((n) => n.id === "tc:test");
    expect(notice?.body).toBe("This is an invite, not an enrollment.");
    expect(notice?.title).toBe("Trusted contacts");
    expect(notice?.tone).toBe("err");
  });

  it("clears both when the next step starts, and hands back the value of one that works", async () => {
    const { result } = renderHook(() =>
      useCeremonyFailure("tc:next", "Circle"),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new PacketError("format", "this is not a packet");
      });
    });
    expect(listNotices().some((n) => n.id === "tc:next")).toBe(true);
    const attempts: Attempt<number>[] = [];
    await act(async () => {
      attempts.push(await result.current.run(async () => 7));
    });
    expect(attempts).toEqual([{ ok: true, value: 7 }]);
    expect(result.current.message).toBe("");
    expect(listNotices().some((n) => n.id === "tc:next")).toBe(false);
  });

  it("raises an identical sentence again after the person dismissed it", async () => {
    const { result } = renderHook(() =>
      useCeremonyFailure("tc:again", "Circle"),
    );
    const fail = () =>
      result.current.run(async () => {
        throw new DeskError("x", "Nothing here.");
      });
    await act(async () => {
      await fail();
    });
    clearNotices();
    expect(listNotices().some((n) => n.id === "tc:again")).toBe(false);
    await act(async () => {
      await fail();
    });
    expect(listNotices().some((n) => n.id === "tc:again")).toBe(true);
  });

  it("answers a thrown non-error with the generic sentence", async () => {
    const { result } = renderHook(() => useCeremonyFailure("tc:odd", "Circle"));
    await act(async () => {
      await result.current.run(async () => {
        throw "plain text";
      });
    });
    expect(result.current.message).toBe(GENERIC_FAILURE);
  });
});
