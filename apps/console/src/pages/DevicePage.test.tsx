import { overlapCast } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { type ReactElement, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevicePage } from "./DevicePage.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render(ui: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#user-code");
  if (!input) throw new Error("user code input not rendered");
  return input;
}

function approveButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.primary");
  if (!button) throw new Error("approve button not rendered");
  return button;
}

function jsonResponse(status: number): Response {
  return overlapCast({ ok: status >= 200 && status < 300, status });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("DevicePage", () => {
  it("refuses to approve an empty user code without calling the API", async () => {
    await render(<DevicePage />);
    await click(approveButton());
    expect(container.textContent).toContain(
      "Enter the user code shown in your terminal.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uppercases the code as it is typed and approves it", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200));
    await render(<DevicePage />);
    await type(field(), "abcd-efgh");
    expect(field().value).toBe("ABCD-EFGH");
    await click(approveButton());
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/v1/device/approve",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      }),
    );
    expect(container.textContent).toContain(
      "CLI session authorized. You can return to the terminal.",
    );
  });

  it("approves on Enter from the code field", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200));
    await render(<DevicePage />);
    await type(field(), "WXYZ-1234");
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("CLI session authorized.");
  });

  it("ignores other keys in the code field", async () => {
    await render(<DevicePage />);
    await type(field(), "WXYZ-1234");
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains that sign-in is required on 401 and 403", async () => {
    for (const status of [401, 403]) {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(status));
      await render(<DevicePage />);
      await type(field(), "ABCD-EFGH");
      await click(approveButton());
      expect(container.textContent).toContain(
        "Sign in first, then authorize this CLI code.",
      );
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.mocked(fetch).mockClear();
    }
  });

  it("explains an unknown or expired code on 404", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404));
    await render(<DevicePage />);
    await type(field(), "ABCD-EFGH");
    await click(approveButton());
    expect(container.textContent).toContain(
      "That user code was not found or has expired.",
    );
  });

  it("reports the status for any other failure", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(500));
    await render(<DevicePage />);
    await type(field(), "ABCD-EFGH");
    await click(approveButton());
    expect(container.textContent).toContain(
      "Approval failed (500). Try again shortly.",
    );
  });

  it("surfaces a non-Error rejection as text", async () => {
    vi.mocked(fetch).mockRejectedValue("socket gone");
    await render(<DevicePage />);
    await type(field(), "ABCD-EFGH");
    await click(approveButton());
    expect(container.textContent).toContain("socket gone");
  });

  it("disables the form while an approval is in flight", async () => {
    let release: (res: Response) => void = () => {};
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await render(<DevicePage />);
    await type(field(), "ABCD-EFGH");
    // act() only awaits its own callback; the fetch promise stays pending.
    await act(async () => {
      approveButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(approveButton().disabled).toBe(true);
    expect(approveButton().textContent).toBe("Authorizing…");
    expect(field().disabled).toBe(true);
    release(jsonResponse(200));
    await act(async () => {});
    expect(approveButton().disabled).toBe(false);
  });
});
