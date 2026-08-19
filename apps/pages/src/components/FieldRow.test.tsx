import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copySecret = vi.hoisted(() => vi.fn());

vi.mock("../lib/vault/hooks.js", () => ({
  useCopySecret: () => copySecret,
}));

import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "./FieldRow.js";

function CopyHarness() {
  const { copied, failed, copy } = useCopyFeedback();
  return (
    <div>
      <button type="button" onClick={() => void copy("pw", "s3cret")}>
        go
      </button>
      <output data-testid="copied">{copied ?? ""}</output>
      <output data-testid="failed">{failed ?? ""}</output>
    </div>
  );
}

describe("useCopyFeedback", () => {
  beforeEach(() => {
    copySecret.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("marks the key copied and clears the flag after the feedback window", async () => {
    vi.useFakeTimers();
    copySecret.mockResolvedValue("copied");
    render(<CopyHarness />);
    fireEvent.click(screen.getByText("go"));
    await act(async () => {});
    expect(screen.getByTestId("copied").textContent).toBe("pw");
    expect(copySecret).toHaveBeenCalledWith("s3cret");
    expect(screen.getByTestId("failed").textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByTestId("copied").textContent).toBe("");
  });

  it("marks the key failed when the clipboard is unavailable", async () => {
    vi.useFakeTimers();
    copySecret.mockResolvedValue("unavailable");
    render(<CopyHarness />);
    fireEvent.click(screen.getByText("go"));
    await act(async () => {});
    expect(screen.getByTestId("failed").textContent).toBe("pw");
    expect(screen.getByTestId("copied").textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByTestId("failed").textContent).toBe("");
  });

  it("replaces a pending feedback timer when copying again", async () => {
    copySecret.mockResolvedValue("copied");
    render(<CopyHarness />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() =>
      expect(screen.getByTestId("copied").textContent).toBe("pw"),
    );
    fireEvent.click(screen.getByText("go"));
    await waitFor(() =>
      expect(screen.getByTestId("copied").textContent).toBe("pw"),
    );
  });
});

describe("FieldRow", () => {
  afterEach(cleanup);

  it("renders label and children", () => {
    render(
      <FieldRow label="Username">
        <span>alice@example.com</span>
      </FieldRow>,
    );
    expect(screen.getByText("Username")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
  });

  it("renders actions only when provided", () => {
    const { container: bare } = render(
      <FieldRow label="A">
        <span>x</span>
      </FieldRow>,
    );
    expect(bare.querySelector(".frow__actions")).toBeNull();

    const { container: withActions } = render(
      <FieldRow label="A" actions={<button type="button">act</button>}>
        <span>x</span>
      </FieldRow>,
    );
    expect(withActions.querySelector(".frow__actions")).toBeTruthy();
  });
});

describe("CopyButton", () => {
  afterEach(cleanup);

  const base = {
    value: "s3cret",
    label: "Password",
    fieldKey: "pw",
  };

  it("copies via onCopy with the field key and value", () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(
      <CopyButton {...base} copied={null} failed={null} onCopy={onCopy} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy Password" }));
    expect(onCopy).toHaveBeenCalledWith("pw", "s3cret");
  });

  it("shows the copied state for its own key only", () => {
    render(<CopyButton {...base} copied="pw" failed={null} onCopy={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Copied Password" }).className,
    ).toContain("is-on");
    expect(screen.getByText("Password copied to the clipboard")).toBeTruthy();
  });

  it("explains clipboard failure", () => {
    render(<CopyButton {...base} copied={null} failed="pw" onCopy={vi.fn()} />);
    const button = screen.getByRole("button", {
      name: "Could not copy Password",
    });
    expect(button.getAttribute("title")).toMatch(/blocked clipboard/);
    expect(screen.getByText("Could not copy Password")).toBeTruthy();
  });

  it("stays neutral when another field holds the feedback", () => {
    render(
      <CopyButton {...base} copied="other" failed={null} onCopy={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "Copy Password" }).className,
    ).not.toContain("is-on");
  });
});

describe("ConcealedValue", () => {
  afterEach(cleanup);

  it("masks the value until revealed", () => {
    render(
      <ConcealedValue value="hunter2" label="Password" revealed={false} />,
    );
    expect(screen.queryByText("hunter2")).toBeNull();
    expect(screen.getByText("Password is hidden")).toBeTruthy();
  });

  it("shows the value in mono when revealed", () => {
    const { container } = render(
      <ConcealedValue value="hunter2" label="Password" revealed />,
    );
    expect(screen.getByText("hunter2")).toBeTruthy();
    expect(container.querySelector(".frow__value--mono")).toBeTruthy();
    expect(screen.getByText("Password is visible")).toBeTruthy();
  });
});

describe("RevealButton", () => {
  afterEach(cleanup);

  it("toggles and labels itself for the current state", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <RevealButton revealed={false} label="Password" onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal Password" }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<RevealButton revealed label="Password" onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: "Hide Password" });
    expect(button.className).toContain("is-on");
  });
});
