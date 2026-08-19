// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

vi.mock("@opensesame/sdk-browser", () => ({
  createOpenSesame: vi.fn(() => ({
    signIn: vi.fn(),
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  })),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function renderAt(entry: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>,
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("App shell", () => {
  it("renders the brand, issuer, and navigation", async () => {
    await renderAt("/device");
    expect(container.textContent).toContain("OpenSesame");
    expect(container.textContent).toContain("Identity console · issuer");
    const nav = container.querySelector("nav");
    expect(nav?.textContent).toContain("Sign in");
    expect(nav?.textContent).toContain("Authorize CLI");
    expect(nav?.textContent).toContain("Claim ownership");
    expect(nav?.textContent).toContain("Task access");
  });

  it("routes / to the sign-in page", async () => {
    await renderAt("/");
    expect(container.textContent).toContain("Sign in with OpenSesame");
  });

  it("routes /device to the device authorization page", async () => {
    await renderAt("/device");
    expect(container.textContent).toContain("Authorize this CLI session");
  });

  it("routes /claim to the claim ceremony", async () => {
    await renderAt("/claim");
    expect(container.textContent).toContain(
      "Claim ownership of this agent/project/resources",
    );
  });

  it("routes /task-access to the trust ratchet page", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await renderAt("/task-access");
    expect(container.textContent).toContain("Enter a task run id");
    vi.unstubAllGlobals();
  });
});
