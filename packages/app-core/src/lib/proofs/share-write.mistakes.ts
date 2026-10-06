/**
 * Mistakes the type checker must keep refusing (ADR 0178).
 *
 * Each `@ts-expect-error` is a way to write a share without the authority for
 * the tomb it lands in. `tsc` fails the build if one starts to compile.
 * Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import {
  createLocalShareAs,
  revokeSharesForSession,
} from "../local-share-grants.js";
import { requireManageGrants, systemShareWrite } from "./share-write.js";

export async function shareWriteMistakes(
  input: Parameters<typeof createLocalShareAs>[1],
): Promise<void> {
  await name("tomb-a", "tomb-b", async (a, b) => {
    const manageA = await requireManageGrants(a);
    const systemB = systemShareWrite(b);

    // The honest paths compile.
    await createLocalShareAs(a, input, manageA);
    await revokeSharesForSession(b, "session", systemB);

    // @ts-expect-error — a grant check in tomb A does not authorize tomb B.
    await createLocalShareAs(b, input, manageA);

    // @ts-expect-error — system authority for B does not cover A.
    await revokeSharesForSession(a, "session", systemB);

    // @ts-expect-error — no authority at all.
    await revokeSharesForSession(a, "session");

    // @ts-expect-error — a boolean is not an authority.
    await revokeSharesForSession(a, "session", { bypassAccessCheck: true });

    // @ts-expect-error — a raw tomb id is not a named tomb.
    await revokeSharesForSession("tomb-a", "session", manageA);
  });
}
