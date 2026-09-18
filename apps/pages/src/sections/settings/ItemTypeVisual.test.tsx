/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ItemTypeVisual } from "./ItemTypeVisual.js";

const TICKET = JSON.stringify({
  spec: {
    sections: [
      {
        fields: [
          { id: "event", type: "string", label: "Event" },
          { id: "reference", type: "concealed", label: "Booking reference" },
        ],
      },
    ],
  },
});

afterEach(() => cleanup());

describe("ItemTypeVisual", () => {
  it("keeps authored JSON in Source and lists concealed fields in Visual", async () => {
    render(<ItemTypeVisual draft={TICKET} onDraft={() => undefined} />);
    expect(screen.getByLabelText("Add a type")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Visual" }));
    expect(screen.getByText(/Booking reference/)).toBeTruthy();
    expect(screen.getByText(/never searchable/)).toBeTruthy();
  });
});
