/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addEntries, useAddEntry } from "./add-menu.js";

function Flow({
  id,
  order,
  run = () => undefined,
}: { id: string; order: number; run?: () => void }) {
  useAddEntry({ id, label: `Do ${id}`, order, run });
  return null;
}

afterEach(cleanup);

describe("the Add button's menu entries", () => {
  it("lists what is mounted, lowest order first, and forgets what unmounts", () => {
    const view = render(
      <>
        <Flow id="export" order={20} />
        <Flow id="import" order={10} />
      </>,
    );
    expect(addEntries().map((entry) => entry.id)).toEqual(["import", "export"]);
    view.rerender(<Flow id="export" order={20} />);
    expect(addEntries().map((entry) => entry.id)).toEqual(["export"]);
    view.unmount();
    expect(addEntries()).toEqual([]);
  });

  it("runs the flow it was registered with", () => {
    const run = vi.fn();
    render(<Flow id="import" order={10} run={run} />);
    addEntries()[0]?.run();
    expect(run).toHaveBeenCalledOnce();
  });
});
