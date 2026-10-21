import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
/** @vitest-environment jsdom */
import {
  createLocalShare,
  revokeLocalShare,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSharedItems } from "./use-shared-items.js";

function Probe({ tomb }: { tomb: string }) {
  const shared = useSharedItems(tomb);
  return (
    <output data-testid="shared">
      {[...shared]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, count]) => `${id}:${count}`)
        .join(",")}
    </output>
  );
}

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("counts standing item grants and reloads when the ledger changes", async () => {
  const fixture = await localRequestFixture();
  render(<Probe tomb={fixture.tomb} />);
  await waitFor(() =>
    expect(screen.getByTestId("shared").textContent).toBe(""),
  );

  await act(async () => {
    await createLocalShare(fixture.tomb, {
      principalId: fixture.personId,
      resourceKind: "item",
      resourceId: "item-1",
      resourceLabel: "Work / API key",
      policy: "read",
      durationSeconds: 3600,
    });
  });
  await waitFor(() =>
    expect(screen.getByTestId("shared").textContent).toBe("item-1:1"),
  );

  let secondShareId = "";
  await act(async () => {
    const shares = await createLocalShare(fixture.tomb, {
      principalId: fixture.personId,
      resourceKind: "item",
      resourceId: "item-2",
      resourceLabel: "Work / Other key",
      policy: "read",
      durationSeconds: 3600,
    });
    secondShareId =
      shares.find((share) => share.resourceId === "item-2")?.id ?? "";
  });
  await waitFor(() =>
    expect(screen.getByTestId("shared").textContent).toBe("item-1:1,item-2:1"),
  );

  await act(async () => {
    await revokeLocalShare(fixture.tomb, secondShareId);
  });
  await waitFor(() =>
    expect(screen.getByTestId("shared").textContent).toBe("item-1:1"),
  );
});
