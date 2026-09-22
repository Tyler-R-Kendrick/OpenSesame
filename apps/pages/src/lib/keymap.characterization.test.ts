/** @vitest-environment jsdom */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerLegacyShellData } from "./contributions.test-support.js";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
  keymapHelp,
  registerVaultKeymap,
} from "./keymap.js";

/**
 * Characterization snapshots for the listing keymap.
 *
 * Vitest file snapshots here are this repo's Verify equivalent: the first
 * run writes `__snapshots__/`, later runs fail on drift until you accept
 * the diff (`vitest -u`) after reading it.
 */

function target() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (
      ...args: Parameters<
        NonNullable<VaultKeymapTarget[keyof VaultKeymapTarget]>
      >
    ) => {
      calls.push(args.length ? `${name}:${args.join(",")}` : name);
    };
  const listing: VaultKeymapTarget = {
    next: record("next"),
    previous: record("previous"),
    first: record("first"),
    last: record("last"),
    enter: record("enter"),
    parent: record("parent"),
    activate: record("activate"),
    page: record("page"),
    edge: record("edge"),
    focus: record("focus"),
    toIndex: record("toIndex"),
    search: record("search"),
    closeSearch: record("closeSearch"),
    copySecret: record("copySecret"),
    copyUsername: record("copyUsername"),
    edit: record("edit"),
    trash: record("trash"),
    create: record("create"),
    favorite: record("favorite"),
    share: record("share"),
  };
  return Object.assign(listing, { calls });
}

// The sheet and the `g` jumps are both the plan's: with nothing registered
// this shell has `g v/s` and no `/access`. The snapshots characterize the
// full set of sections, so the fixture stands for the whole file rather than
// one test — a release inside a test never runs when its expect throws.
let revokeShell = () => {};
beforeAll(() => {
  revokeShell = registerLegacyShellData();
});
afterAll(() => revokeShell());

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("listing keymap copy", () => {
  it("says exactly this on the ? sheet", () => {
    expect([...keymapHelp()]).toMatchSnapshot();
  });
});

describe("listing keymap session", () => {
  it("records this dispatch log for a vim-like pass", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const navigate: string[] = [];
    const handler = createKeymapHandler({
      navigate: (path) => navigate.push(path),
      showHelp: () => tree.calls.push("help"),
    });
    const play = (key: string, init: KeyboardEventInit = {}) => {
      handler(
        new KeyboardEvent("keydown", {
          key,
          cancelable: true,
          shiftKey:
            init.shiftKey ?? (key.length === 1 && key !== key.toLowerCase()),
          ...init,
        }),
      );
    };

    play("j");
    play("5");
    play("k");
    play("g");
    play("g");
    play("G");
    play("1");
    play("G");
    play("d", { ctrlKey: true });
    play("H");
    play("g");
    play("a");
    play("?");

    expect({ calls: tree.calls, navigate }).toMatchSnapshot();
    release();
  });
});
