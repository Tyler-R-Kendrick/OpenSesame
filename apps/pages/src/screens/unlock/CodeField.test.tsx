/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeField } from "./CodeField.js";

function renderField(onChange = vi.fn(), onComplete = vi.fn()) {
  render(
    <>
      <label htmlFor="code">Authenticator code</label>
      <CodeField
        id="code"
        inputRef={createRef()}
        value=""
        disabled={false}
        onChange={onChange}
        onComplete={onComplete}
      />
    </>,
  );
  return { onChange, onComplete };
}

afterEach(cleanup);

describe("CodeField", () => {
  it("draws one decorative slot per digit", () => {
    renderField();
    expect(document.querySelectorAll(".codefield__slots span")).toHaveLength(
      6,
    );
    expect(
      document.querySelector(".codefield__slots")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("constrains entry to digits, so a paste of a spaced code lands whole", () => {
    const { onChange, onComplete } = renderField();
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123 456" },
    });
    expect(onChange).toHaveBeenCalledWith("123456");
  });

  it("completes itself once every slot is filled", async () => {
    const { onComplete } = renderField();
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("waits while any slot is empty", async () => {
    const { onChange, onComplete } = renderField();
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "12345" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).toHaveBeenCalledWith("12345");
    expect(onComplete).not.toHaveBeenCalled();
  });
});
