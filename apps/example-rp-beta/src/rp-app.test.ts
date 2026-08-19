import type { Session } from "@opensesame/sdk-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace vitest config runs in a node environment with no DOM, so the
 * component is exercised through a minimal hook harness: `useState` slots are
 * kept in an array, `useEffect` callbacks are captured for manual flushing,
 * and the returned JSX tree is walked as plain data. The SDK client is mocked
 * at the module boundary.
 */

const stateSlots: unknown[] = [];
let stateCursor = 0;
let effectCallbacks: Array<() => void> = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const slot = stateCursor++;
      if (!(slot in stateSlots)) {
        stateSlots[slot] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((prev: T) => T)) => {
        stateSlots[slot] =
          typeof next === "function"
            ? (next as (prev: T) => T)(stateSlots[slot] as T)
            : next;
      };
      return [stateSlots[slot] as T, setState] as const;
    },
    useEffect: (cb: () => void) => {
      effectCallbacks.push(cb);
    },
    useMemo: <T>(factory: () => T) => factory(),
  };
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "access-token",
    anonymous: false,
    raw: { access_token: "access-token", token_type: "Bearer" },
    ...overrides,
  };
}

const { client, createOpenSesameMock } = vi.hoisted(() => {
  const client = {
    signIn: vi.fn<() => Promise<void>>(async () => {}),
    signOut: vi.fn<() => Promise<void>>(async () => {}),
    getSession: vi.fn<() => Promise<Session | null>>(async () => null),
    handleRedirectCallback: vi.fn<(url: string) => Promise<Session>>(
      async () => ({
        accessToken: "access-token",
        anonymous: false,
        raw: { access_token: "access-token", token_type: "Bearer" },
      }),
    ),
  };
  return { client, createOpenSesameMock: vi.fn(() => client) };
});

vi.mock("@opensesame/sdk-browser", () => ({
  createOpenSesame: createOpenSesameMock,
}));

import { RpApp } from "./RpApp.js";

const props = {
  name: "RP Beta",
  clientId: "rp-beta",
  sector: "https://beta.example.test",
  port: 5175,
};

type TestElement = { type: unknown; props: Record<string, unknown> };

function asArray(node: unknown): unknown[] {
  return Array.isArray(node) ? node : [node];
}

function walk(node: unknown, visit: (el: TestElement) => void): void {
  for (const child of asArray(node)) {
    if (child === null || child === undefined || typeof child !== "object") {
      continue;
    }
    const el = child as TestElement;
    if (el.props === null || typeof el.props !== "object") continue;
    visit(el);
    walk(el.props.children, visit);
  }
}

function findAll(
  node: unknown,
  pred: (el: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  walk(node, (el) => {
    if (pred(el)) found.push(el);
  });
  return found;
}

function textOf(node: unknown): string {
  return asArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (child !== null && typeof child === "object") {
        return textOf((child as TestElement).props?.children);
      }
      return "";
    })
    .join("");
}

function render(componentProps: typeof props = props): TestElement {
  stateCursor = 0;
  effectCallbacks = [];
  return RpApp(componentProps) as unknown as TestElement;
}

function runEffects(): void {
  for (const cb of effectCallbacks) cb();
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function stubBrowser(search: string) {
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: {
      search,
      href: `http://127.0.0.1:5175/${search}`,
    },
  });
  vi.stubGlobal("history", { replaceState });
  return { replaceState };
}

function buttons(tree: TestElement): TestElement[] {
  return findAll(tree, (el) => el.type === "button");
}

function buttonByText(tree: TestElement, text: string): TestElement {
  const match = buttons(tree).find((el) => textOf(el).includes(text));
  if (!match) throw new Error(`button not found: ${text}`);
  return match;
}

function outputs(tree: TestElement): string[] {
  return findAll(tree, (el) => el.type === "output").map((el) => textOf(el));
}

function demoDigest(sector: string): string {
  return Array.from(new TextEncoder().encode(`${sector}:demo-principal`))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

beforeEach(() => {
  stateSlots.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("RpApp", () => {
  it("configures the SDK client with issuer, client id, and loopback redirect", () => {
    render();
    expect(createOpenSesameMock).toHaveBeenCalledWith({
      issuer: "http://127.0.0.1:8788",
      clientId: "rp-beta",
      redirectUri: "http://127.0.0.1:5175/",
    });
  });

  it("honours a VITE_OPENSESAME_ISSUER override", async () => {
    vi.stubEnv("VITE_OPENSESAME_ISSUER", "https://id.example.test");
    vi.resetModules();
    const { RpApp: RpAppWithEnv } = await import("./RpApp.js");
    stateCursor = 0;
    effectCallbacks = [];
    RpAppWithEnv(props);
    expect(createOpenSesameMock).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "https://id.example.test" }),
    );
    vi.resetModules();
  });

  it("renders the relying-party identity from its props", () => {
    const tree = render();
    const text = textOf(tree);
    expect(text).toContain("RP Beta");
    expect(text).toContain("rp-beta");
    expect(text).toContain("https://beta.example.test");
    expect(text).toContain("Canonical principal ids");
  });

  it("loads an existing session on mount and shows its pairwise sub", async () => {
    client.getSession.mockResolvedValue(makeSession({ sub: "pw_beta123" }));
    stubBrowser("");
    render();
    runEffects();
    await flushAsync();
    const tree = render();
    expect(outputs(tree).join("\n")).toContain("pw_beta123");
    // Signed-out hint must not show when a session is present.
    expect(outputs(tree).join("\n")).not.toContain("Signed out.");
  });

  it("shows the signed-out affordance once a null session resolves", async () => {
    client.getSession.mockResolvedValue(null);
    stubBrowser("");
    render();
    runEffects();
    await flushAsync();
    const tree = render();
    expect(outputs(tree).join("\n")).toContain("Signed out.");
    // Ready phase: buttons are enabled again.
    for (const btn of buttons(tree)) {
      expect(btn.props.disabled).toBe(false);
    }
  });

  it("falls back to an opaque-token label when the session has no sub", async () => {
    client.getSession.mockResolvedValue(makeSession());
    stubBrowser("");
    render();
    runEffects();
    await flushAsync();
    const tree = render();
    expect(outputs(tree).join("\n")).toContain("present (opaque token)");
  });

  it("completes the redirect callback and strips the code from the URL", async () => {
    const { replaceState } = stubBrowser("?code=abc&state=xyz");
    client.handleRedirectCallback.mockResolvedValue(
      makeSession({ sub: "pw_from_callback" }),
    );
    render();
    runEffects();
    // While the exchange is pending the UI is in the completing phase.
    const pending = render();
    expect(outputs(pending).join("\n")).toContain("Completing sign-in…");
    for (const btn of buttons(pending)) {
      expect(btn.props.disabled).toBe(true);
    }
    await flushAsync();
    const tree = render();
    expect(client.handleRedirectCallback).toHaveBeenCalledWith(
      "http://127.0.0.1:5175/?code=abc&state=xyz",
    );
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(outputs(tree).join("\n")).toContain("pw_from_callback");
  });

  it("surfaces callback errors and returns to the idle phase", async () => {
    stubBrowser("?code=abc&state=xyz");
    client.handleRedirectCallback.mockRejectedValue(
      new Error("OAuth state mismatch"),
    );
    render();
    runEffects();
    await flushAsync();
    const tree = render();
    const alerts = findAll(tree, (el) => el.props.role === "alert");
    expect(alerts).toHaveLength(1);
    expect(textOf(alerts[0] as TestElement)).toContain("OAuth state mismatch");
    for (const btn of buttons(tree)) {
      expect(btn.props.disabled).toBe(false);
    }
  });

  it("uses a generic message when the callback fails with a non-Error", async () => {
    stubBrowser("?code=abc&state=xyz");
    client.handleRedirectCallback.mockRejectedValue("network gone");
    render();
    runEffects();
    await flushAsync();
    const tree = render();
    const alerts = findAll(tree, (el) => el.props.role === "alert");
    expect(textOf(alerts[0] as TestElement)).toContain(
      "Sign-in callback failed. Try signing in again.",
    );
  });

  it("derives a deterministic sector-specific mock pairwise sub", () => {
    let tree = render();
    (
      buttonByText(tree, "Demo pairwise sub (mock)").props.onClick as () => void
    )();
    tree = render();
    expect(outputs(tree).join("\n")).toContain(
      `pw_${demoDigest(props.sector)}`,
    );
    // A different sector yields a different sub — pairwise means pairwise.
    tree = render({ ...props, sector: "https://alpha.example.test" });
    (
      buttonByText(tree, "Demo pairwise sub (mock)").props.onClick as () => void
    )();
    tree = render({ ...props, sector: "https://alpha.example.test" });
    const text = outputs(tree).join("\n");
    expect(text).toContain(`pw_${demoDigest("https://alpha.example.test")}`);
    expect(text).not.toContain(`pw_${demoDigest(props.sector)}`);
  });

  it("delegates sign-in to the SDK client", () => {
    const tree = render();
    (buttonByText(tree, "Sign in").props.onClick as () => void)();
    expect(client.signIn).toHaveBeenCalledTimes(1);
  });

  it("sign-out clears session and mock sub, then delegates to the SDK", async () => {
    client.getSession.mockResolvedValue(makeSession({ sub: "pw_beta123" }));
    stubBrowser("");
    render();
    runEffects();
    await flushAsync();
    let tree = render();
    (
      buttonByText(tree, "Demo pairwise sub (mock)").props.onClick as () => void
    )();
    tree = render();
    expect(outputs(tree).join("\n")).toContain("pw_beta123");
    (buttonByText(tree, "Sign out").props.onClick as () => void)();
    await flushAsync();
    tree = render();
    expect(client.signOut).toHaveBeenCalledTimes(1);
    const text = outputs(tree).join("\n");
    expect(text).not.toContain("pw_beta123");
    expect(text).not.toContain("pw_");
  });
});
