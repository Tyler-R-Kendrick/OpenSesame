/**
 * Mistakes the type checker must keep refusing (ADR 0177).
 *
 * Each `@ts-expect-error` is a way to get a vault item without share reach for
 * that item, or to read with a proof that only covers something else. `tsc`
 * fails the build if one starts to compile. Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import { findItem } from "../../webmcp/tool-shared.js";
import { reachItemRead, reachItemWrite } from "./item-reach.js";

export async function itemReachMistakes(): Promise<void> {
  await name("item-a", "item-b", async (a, b) => {
    const readA = await reachItemRead(a);
    const writeB = await reachItemWrite(b);

    // The honest paths compile: a proof about `a` fetches `a`.
    findItem(a, readA);
    findItem(b, writeB);

    // @ts-expect-error — reach for item A does not cover item B.
    findItem(b, readA);

    // @ts-expect-error — no proof at all.
    findItem(a);

    // @ts-expect-error — a raw id is not a named item.
    findItem("item-a", readA);

    // @ts-expect-error — a read proof is not a write proof.
    const wrongKind: typeof writeB = readA;
    void wrongKind;
  });
}
