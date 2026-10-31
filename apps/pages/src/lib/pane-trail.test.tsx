/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  BrowserRouter,
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./keymap-commands.js";
import { type Ascend, usePaneTrail } from "./pane-trail.js";
import { vaultPane } from "./vault-list-path.js";

type Handle = {
  ascend: Ascend;
  go: (to: string) => void;
  back: () => void;
  at: () => string;
  type: () => string;
  close: () => void;
  remount: () => void;
};

/** Mounts the hook where a phone's vault would, and hands back its controls. */
function mount(
  entries: string[],
  index = entries.length - 1,
  native = false,
  basename = "/",
): Handle {
  const handle: Handle = {
    ascend: () => undefined,
    go: () => undefined,
    back: () => undefined,
    at: () => "",
    type: () => "",
    close: () => undefined,
    remount: () => undefined,
  };
  function Probe() {
    const { pathname, search, hash } = useLocation();
    const navigate = useNavigate();
    const type = useNavigationType();
    const ascend = usePaneTrail(
      vaultPane(pathname, new URLSearchParams(search)),
    );
    handle.ascend = ascend;
    handle.go = (to) => navigate(to);
    handle.back = () => navigate(-1);
    handle.at = () => pathname + search + hash;
    handle.type = () => type;
    return null;
  }
  function Workspace() {
    const [version, setVersion] = useState(0);
    handle.remount = () => setVersion((value) => value + 1);
    return <Probe key={version} />;
  }
  if (native)
    window.history.replaceState(
      null,
      "",
      `${basename === "/" ? "" : basename}${entries[index]}`,
    );
  const view = render(
    native ? (
      <BrowserRouter basename={basename}>
        <Workspace />
      </BrowserRouter>
    ) : (
      <MemoryRouter initialEntries={entries} initialIndex={index}>
        <Workspace />
      </MemoryRouter>
    ),
  );
  handle.close = view.unmount;
  return handle;
}

const run = (fn: () => void) => act(async () => fn());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function jump(vault: Handle, section: string) {
  runCommand(`section.${section}`, {
    event: { target: document.body },
    steps: 1,
    hadCount: false,
    navigate: vault.go,
    showHelp: () => undefined,
  });
}

/** Retain a real native traversal target until the test releases its task. */
function retainNativePop() {
  const go = window.history.go.bind(window.history);
  let target = 0;
  vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
    target = window.history.length + delta;
  });
  return () => go(target - window.history.length);
}

describe("usePaneTrail", () => {
  it("does not queue two climbs from the same rendered entry", async () => {
    const vault = mount(["/", "/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => {
      vault.ascend("list", "/vault?f=all");
      vault.ascend("list", "/vault?f=all");
    });
    expect(vault.at()).toBe("/vault?f=all");
    await run(() => vault.back());
    expect(vault.at()).toBe("/vault");
  });

  it("executes the latest explicit section jump after the pending pane arrives", async () => {
    const vault = mount(["/", "/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => {
      vault.ascend("list", "/vault?f=all");
      vault.ascend("list", "/vault?f=all");
      jump(vault, "vault");
      jump(vault, "settings");
    });
    expect(vault.at()).toBe("/settings");
    await run(() => vault.back());
    expect(vault.at()).toBe("/vault?f=all");
  });

  it("does not let an unknown section replace a valid queued jump", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => {
      vault.ascend("list", "/vault?f=all");
      jump(vault, "settings");
      jump(vault, "unknown");
    });
    expect(vault.at()).toBe("/settings");
  });

  it("holds the latest jump before native POP, then preserves ordinary Back", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    act(() => {
      vault.ascend("list", "/vault?f=all");
      jump(vault, "vault");
      jump(vault, "settings");
      expect(vault.at()).toBe("/vault/a?f=all");
      expect(window.location.pathname).toBe("/vault/a");
    });
    await waitFor(() => expect(vault.at()).toBe("/settings"));
    await run(() => vault.back());
    await waitFor(() => expect(vault.at()).toBe("/vault?f=all"));
  });

  it("holds a jump arriving between native POP and React's arrival", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    const onPop = () => jump(vault, "settings");
    window.addEventListener("popstate", onPop, { once: true });
    try {
      await run(() => vault.ascend("list", "/vault?f=all"));
      await waitFor(() => expect(vault.at()).toBe("/settings"));
    } finally {
      window.removeEventListener("popstate", onPop);
    }
  });

  it("acknowledges native POP even when a push replaces that React arrival", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    const onPop = () => {
      vault.go("/vault?f=secret");
      jump(vault, "settings");
    };
    window.addEventListener("popstate", onPop, { once: true });
    try {
      await run(() => vault.ascend("list", "/vault?f=all"));
      await waitFor(() => expect(vault.at()).toBe("/settings"));
    } finally {
      window.removeEventListener("popstate", onPop);
    }
  });

  it("cancels a queued jump when its workspace unmounts", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    act(() => {
      vault.ascend("list", "/vault?f=all");
      jump(vault, "settings");
      vault.close();
    });
    const replacement = mount(["/vault/a?f=all"], 0, true);
    await waitFor(() => expect(replacement.at()).toBe("/vault?f=all"));
    await run(() => jump(replacement, "settings"));
    expect(replacement.at()).toBe("/settings");
  });

  it("waits for actual POP despite an intervening same-workspace push", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    const release = retainNativePop();
    act(() => {
      vault.ascend("list", "/vault?f=all");
      jump(vault, "settings");
    });
    await run(() => {
      vault.go("/vault?f=secret");
    });
    expect(vault.at()).toBe("/vault?f=secret");
    release();
    await waitFor(() => expect(vault.at()).toBe("/settings"));
  });

  it.each([
    { initial: false, base: "/" },
    { initial: true, base: "/" },
    { initial: true, base: "/OpenSesame" },
  ])(
    "ignores unrelated hash POP before target ($base initial=$initial)",
    async ({ initial, base }) => {
      const search = initial ? "?f=all" : "?f=a b";
      const vault = mount(
        [initial ? `/vault${search}` : "/vault"],
        0,
        true,
        base,
      );
      if (!initial) await run(() => vault.go(`/vault${search}`));
      await run(() => vault.go(`/vault/a${search}`));
      const release = retainNativePop();
      act(() => {
        vault.ascend("list", `/vault${search}`);
        jump(vault, "settings");
      });
      try {
        window.location.hash = "unrelated";
        const expected = new URL(
          `/vault/a${search}#unrelated`,
          window.location.href,
        );
        await waitFor(() =>
          expect(vault.at()).toBe(
            expected.pathname + expected.search + expected.hash,
          ),
        );
      } finally {
        release();
        await waitFor(() => expect(vault.at()).toBe("/settings"));
      }
    },
  );

  it("does not retain the old owner's command while a replacement jumps before POP", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    const release = retainNativePop();
    act(() => {
      vault.ascend("list", "/vault?f=all");
      jump(vault, "settings");
      vault.remount();
    });
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault/a?f=all");
    await run(() => jump(vault, "vault"));
    expect(vault.at()).toBe("/vault/a?f=all");
    release();
    await waitFor(() => expect(vault.at()).toBe("/vault"));
    expect(vault.at()).not.toBe("/settings");
  });

  it("clears an unowned traversal when native POP arrives before a new workspace", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    const release = retainNativePop();
    act(() => {
      vault.ascend("list", "/vault?f=all");
      jump(vault, "settings");
      vault.close();
    });
    release();
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        "/vault?f=all",
      ),
    );
    const replacement = mount(["/vault"], 0, true);
    await run(() => jump(replacement, "settings"));
    expect(replacement.at()).toBe("/settings");
  });

  it("releases the barrier when the native traversal request throws", async () => {
    const vault = mount(["/vault"], 0, true);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    vi.spyOn(window.history, "go").mockImplementation(() => {
      throw new Error("native traversal refused");
    });
    expect(() => act(() => vault.ascend("list", "/vault?f=all"))).toThrow(
      "native traversal refused",
    );
    await run(() => jump(vault, "settings"));
    expect(vault.at()).toBe("/settings");
  });

  it("climbing to the tree pops the list, so the system Back goes past it", async () => {
    const vault = mount(["/", "/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("POP");
    await run(() => vault.back());
    expect(vault.at()).toBe("/");
  });

  it("pops past the filter switches between the list and the tree", async () => {
    const vault = mount(["/", "/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault?f=login"));
    await run(() => vault.go("/vault?f=secret"));
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    await run(() => vault.back());
    expect(vault.at()).toBe("/");
  });

  it("climbs from an item to the list it came from, not the one before", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => vault.ascend("list", "/vault?f=all"));
    expect(vault.at()).toBe("/vault?f=all");
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
  });

  it("replaces the entry when no earlier entry holds the pane", async () => {
    const vault = mount(["/vault?f=all"]);
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("REPLACE");
  });

  it("learns an entry it returns to by the system Back button", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => vault.back());
    expect(vault.at()).toBe("/vault?f=all");
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("POP");
  });

  it("does nothing from a pane that is not below the target", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => vault.go("/vault"));
    await run(() => vault.ascend("list", "/vault?f=all"));
    expect(vault.at()).toBe("/vault");
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("PUSH");
  });

  it("takes no pop from a screen the router has already left", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    window.history.replaceState({ key: "ahead", idx: 9 }, "");
    try {
      await run(() => vault.ascend("list", "/vault?f=all"));
      expect(vault.at()).toBe("/vault/a?f=all");
    } finally {
      window.history.replaceState(null, "");
    }
    await run(() => vault.ascend("list", "/vault?f=all"));
    expect(vault.at()).toBe("/vault?f=all");
  });
});
