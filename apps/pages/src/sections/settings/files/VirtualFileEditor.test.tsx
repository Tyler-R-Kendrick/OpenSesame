/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type {
  VirtualFile,
  VirtualFileProvider,
} from "@opensesame/app-core/sections/settings/virtual-files.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inTray } from "../../../components/tray.test-support.js";
import { VirtualFileEditor } from "./VirtualFileEditor.js";

afterEach(() => {
  cleanup();
  clearNotices();
});

const file: VirtualFile = {
  path: "settings/notes/order.json",
  language: "json",
  readOnly: false,
  removable: false,
};

const provider = (
  overrides: Partial<VirtualFileProvider>,
): VirtualFileProvider => ({
  list: () => [file],
  read: async () => "{}\n",
  check: (_path, text) =>
    text.includes("bad")
      ? { ok: false, message: "That is not valid." }
      : { ok: true },
  write: async (path) => ({ ok: true, path }),
  remove: async () => ({ ok: false, message: "no" }),
  ...overrides,
});

function area(): HTMLTextAreaElement {
  const field = screen.getByRole("textbox", { name: file.path });
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no file");
  return field;
}

describe("VirtualFileEditor", () => {
  it("takes no typing and no save until the stored text has arrived", async () => {
    let arrive: (text: string) => void = () => undefined;
    const write = vi.fn(async (path: string) => ({ ok: true as const, path }));
    render(
      <VirtualFileEditor
        file={file}
        files={provider({
          read: () =>
            new Promise<string>((resolve) => {
              arrive = resolve;
            }),
          write,
        })}
        onMoved={() => undefined}
      />,
    );
    const save = screen.getByRole("button", { name: `Save ${file.path}` });
    // Typed now, it would be lost under the stored text or run into it.
    expect(area().readOnly).toBe(true);
    expect(area().getAttribute("aria-busy")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(true);
    // An empty field is not yet a refusal: nothing has been read to judge.
    expect(area().getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(save);
    expect(write).not.toHaveBeenCalled();

    arrive('{"order": 1}\n');
    await vi.waitFor(() => expect(area().readOnly).toBe(false));
    expect(area().value).toBe('{"order": 1}\n');
    expect(area().getAttribute("aria-busy")).toBeNull();
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  it("marks a draft that would be refused and raises nothing in the tray", async () => {
    render(
      <VirtualFileEditor
        file={file}
        files={provider({})}
        initial="{}"
        onMoved={() => undefined}
      />,
    );
    fireEvent.change(area(), { target: { value: "bad" } });
    expect(
      screen.getByRole("img", { name: "That is not valid." }),
    ).toBeTruthy();
    expect(area().getAttribute("aria-invalid")).toBe("true");
    expect(listNotices()).toHaveLength(0);
  });

  it("trays a save the provider refused, keyed by the file", async () => {
    render(
      <VirtualFileEditor
        file={file}
        files={provider({
          write: async () => ({ ok: false, message: "The disk is full." }),
        })}
        initial="{}"
        onMoved={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Save ${file.path}` }));
    await screen.findByRole("img", { name: "The disk is full." });
    // The mark and the notice come from one render, but the notice is raised
    // in an effect: wait for it rather than read it the instant the mark shows.
    await vi.waitFor(() => expect(inTray("The disk is full.")).toBe(true));
    expect(listNotices().map((notice) => notice.id)).toEqual([
      `settings-file:${file.path}`,
    ]);
  });
});
