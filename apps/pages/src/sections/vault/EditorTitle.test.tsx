/** @vitest-environment jsdom */
import type { Folder } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorTitle } from "./EditorTitle.js";

const folder = (id: string, name: string): Folder => ({
  id,
  name,
  createdAt: "2026-01-01",
});
const FOLDERS = [
  folder("w", "Work"),
  folder("wt", "Work/Taxes"),
  folder("p", "Personal"),
];

const made = vi.fn<(folder: Folder | null) => void>();
const typed = vi.fn<(typeId: string) => void>();
const submitted = vi.fn();

/** The title row inside a form, as the editor draws it, with its state held. */
function Row({ changeType = true }: { changeType?: boolean }) {
  const [name, setName] = useState("Account");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [typeId, setTypeId] = useState("secret");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <EditorTitle
        value={{ name, folderId }}
        folders={FOLDERS}
        onName={setName}
        onFolder={(next) => {
          made(next);
          setFolderId(next?.id ?? null);
        }}
        onBlur={() => {}}
        typeId={typeId}
        {...(changeType
          ? {
              onTypeChange: (next: string) => {
                typed(next);
                setTypeId(next);
              },
            }
          : {})}
      />
    </form>
  );
}

const folderField = () => screen.getByLabelText<HTMLInputElement>("Folder");
const nameField = () => screen.getByLabelText<HTMLInputElement>("Name");
const typeField = () => screen.getByLabelText<HTMLInputElement>("Type");
const rows = () =>
  screen.queryAllByRole("option").map((row) => row.getAttribute("data-key"));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the title row as one path control", () => {
  it("reads folder, name and type in that order, one field each", () => {
    render(<Row />);
    const fields = [...document.querySelectorAll(".pathfield input")];
    expect(fields.map((field) => field.getAttribute("aria-label"))).toEqual([
      "Folder",
      "Name",
      "Type",
    ]);
    expect([folderField().value, nameField().value, typeField().value]).toEqual(
      ["./", "Account", ".secret"],
    );
    expect(folderField().getAttribute("role")).toBe("combobox");
    expect(typeField().getAttribute("role")).toBe("combobox");
    expect(nameField().getAttribute("role")).toBeNull();
  });

  it("draws a type the route fixed as a label, not a field", () => {
    render(<Row changeType={false} />);
    expect(screen.queryByLabelText("Type")).toBeNull();
    const label = document.querySelector(".editor__ext");
    expect(label?.tagName).toBe("SPAN");
    expect(label?.textContent).toBe(".secret");
  });
});

describe("the folder segment", () => {
  it("opens on a click with every folder, the root first, and nothing chosen yet", async () => {
    render(<Row />);
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(folderField());
    expect(rows()).toEqual(["root", "folder:p", "folder:w", "folder:wt"]);
    expect(folderField().getAttribute("aria-expanded")).toBe("true");
    expect(made).not.toHaveBeenCalled();
  });

  it("does not open from focus alone, so tabbing through the row shows no menu", async () => {
    render(<Row />);
    await userEvent.tab();
    expect(document.activeElement).toBe(folderField());
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.tab();
    expect(document.activeElement).toBe(nameField());
  });

  it("narrows as you type, and Enter takes the best match without submitting the form", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("tax");
    expect(rows()[0]).toBe("folder:wt");
    await userEvent.keyboard("{Enter}");
    expect(folderField().value).toBe("Work/Taxes/");
    expect(made).toHaveBeenCalledWith(FOLDERS[1]);
    expect(submitted).not.toHaveBeenCalled();
    // The caret goes on to the name, at its end, ready to type.
    expect(document.activeElement).toBe(nameField());
    expect(nameField().selectionStart).toBe("Account".length);
  });

  it("moves the highlight with the arrows and takes that row", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    // Opened on the current row (the root), then two down.
    expect(folderField().value).toBe("Work/");
    expect(made).toHaveBeenCalledWith(FOLDERS[0]);
  });

  it("takes the highlighted match when Tab leaves a typed query", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("per");
    await userEvent.tab();
    expect(folderField().value).toBe("Personal/");
    expect(document.activeElement).toBe(nameField());
  });

  it("puts back what was chosen when the text names no folder", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("zzz");
    await userEvent.click(document.body);
    expect(folderField().value).toBe("./");
    expect(made).not.toHaveBeenCalled();
  });

  it("chooses a folder that is typed out exactly, in any case, when focus leaves", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("work/taxes");
    await userEvent.click(document.body);
    expect(folderField().value).toBe("Work/Taxes/");
  });

  it("makes a folder only by choosing its row, rooted where it is typed", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("Clients/2026");
    expect(rows()).toEqual(["new:Clients/2026"]);
    expect(
      screen.getByRole("option", { name: "New folder Clients/2026/" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(folderField().value).toBe("./");
    // The row was the highlighted one, so Enter chose it.
    expect(made).toHaveBeenCalledTimes(1);
    expect(made.mock.calls[0]?.[0]).toMatchObject({ name: "Clients/2026" });
  });

  it("closes its list on Escape and keeps what it had", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.keyboard("per{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(folderField().value).toBe("./");
    expect(document.activeElement).toBe(folderField());
  });

  it("takes a row with the pointer", async () => {
    render(<Row />);
    await userEvent.click(folderField());
    await userEvent.click(screen.getByRole("option", { name: "Personal/" }));
    expect(folderField().value).toBe("Personal/");
    expect(made).toHaveBeenCalledWith(FOLDERS[2]);
  });

  it("holds a typed query to the folder limit", async () => {
    render(<Row />);
    expect(folderField().maxLength).toBe(240);
  });
});

describe("the type segment", () => {
  it("lists only the types there are and narrows by extension", async () => {
    render(<Row />);
    await userEvent.click(typeField());
    expect(rows()).toEqual(expect.arrayContaining(["secret", "file"]));
    await userEvent.keyboard(".fi");
    expect(rows()).toEqual(["file"]);
    await userEvent.keyboard("{Enter}");
    expect(typed).toHaveBeenCalledWith("file");
    expect(typeField().value).toBe(".file");
  });

  it("never keeps an extension that is not on the list", async () => {
    render(<Row />);
    await userEvent.click(typeField());
    await userEvent.keyboard(".nope");
    expect(rows()).toEqual([]);
    expect(typeField().getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(document.body);
    expect(typeField().value).toBe(".secret");
    expect(typed).not.toHaveBeenCalled();
  });

  it("hangs its list from the right edge, under the word it picks", async () => {
    render(<Row />);
    await userEvent.click(typeField());
    expect(screen.getByRole("listbox").className).toContain(
      "pathfield__list--type",
    );
  });
});

describe("moving across the row", () => {
  it("crosses into the next field from the edge of one, and not before", async () => {
    render(<Row />);
    nameField().focus();
    nameField().setSelectionRange(3, 3);
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(nameField());
    await userEvent.keyboard("{Home}{ArrowLeft}");
    expect(document.activeElement).toBe(folderField());
    await userEvent.keyboard("{ArrowRight}");
    // The first press only collapses the selection the focus made.
    expect(document.activeElement).toBe(folderField());
    await userEvent.keyboard("{End}{ArrowRight}");
    expect(document.activeElement).toBe(nameField());
    await userEvent.keyboard("{End}{ArrowRight}");
    expect(document.activeElement).toBe(typeField());
  });
});

describe("the name field", () => {
  it("stops taking text at the name limit", async () => {
    render(<Row />);
    await userEvent.clear(nameField());
    await userEvent.click(nameField());
    await userEvent.paste("x".repeat(200));
    expect(nameField().value).toHaveLength(120);
  });
});
