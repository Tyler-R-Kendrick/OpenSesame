/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHashTarget } from "./hash-target.js";

/** A list whose rows arrive after the tab has rendered, as sealed rows do. */
function LateRows({ delay }: { delay: number }) {
  useHashTarget();
  const [rows, setRows] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setRows(["share-a", "share-b"]), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return (
    <ul>
      {rows.map((id) => (
        <li key={id} id={id}>
          {id}
        </li>
      ))}
    </ul>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a deep link lands on its row", () => {
  it("marks the row it names once that row arrives", async () => {
    vi.useFakeTimers();
    window.scrollBy = vi.fn();
    render(
      <MemoryRouter initialEntries={["/access?view=grants#share-b"]}>
        <LateRows delay={200} />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-hash-target]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    const row = screen.getByText("share-b");
    expect(row.hasAttribute("data-hash-target")).toBe(true);
    expect(screen.getByText("share-a").hasAttribute("data-hash-target")).toBe(
      false,
    );
  });

  it("scrolls to a panel without marking it as a row", async () => {
    window.scrollBy = vi.fn();
    render(
      <MemoryRouter initialEntries={["/connections#catalog"]}>
        <section id="catalog" className="panel">
          <LateRows delay={0} />
        </section>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(document.querySelector("[data-hash-target]")).toBeNull();
  });

  it("marks nothing when the link names no row", async () => {
    render(
      <MemoryRouter initialEntries={["/access?view=grants"]}>
        <LateRows delay={0} />
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(document.querySelector("[data-hash-target]")).toBeNull();
  });
});
