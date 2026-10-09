/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  NativeMcpArgumentGuide,
  nativeMcpArgumentGuide,
} from "./NativeMcpArgumentGuide.js";

afterEach(cleanup);

it("renders the real advertised schema as escaped read-only text without inventing required fields", () => {
  const schema = JSON.stringify({
    type: "object",
    properties: {
      query: { type: "string", description: '<img src=x onerror="alert(1)">' },
    },
  });
  const { container } = render(<NativeMcpArgumentGuide schema={schema} />);
  expect(screen.getByText("None advertised")).toBeTruthy();
  expect(screen.getByLabelText("Advertised argument schema").textContent).toBe(
    schema,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("textarea")).toBeNull();
});

it("refuses missing, malformed, nonobject and oversized UTF-8 argument guidance without truncating it", () => {
  for (const schema of [
    undefined,
    "{",
    "null",
    '{"type":"string"}',
    '{"type":"object","required":[1]}',
  ])
    expect(nativeMcpArgumentGuide(schema)).toBeNull();
  const oversized = JSON.stringify({
    type: "object",
    description: "🔒".repeat(9000),
  });
  expect(oversized.length).toBeLessThan(32768);
  expect(nativeMcpArgumentGuide(oversized)).toBeNull();
  const { container } = render(<NativeMcpArgumentGuide schema={oversized} />);
  expect(container.textContent).toBe("");
});
