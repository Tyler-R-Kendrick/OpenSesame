/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { NativeInputFields } from "./NativeConnectorFields.js";
import type { NativeField } from "./native-connector-ui.js";

afterEach(cleanup);

const fields: readonly NativeField[] = [
  {
    id: "pem",
    label: "Operator CA certificates (PEM)",
    kind: "textarea",
    secret: false,
    required: true,
  },
  {
    id: "targets",
    label: "Integration origins and destination CIDRs",
    kind: "textarea",
    secret: false,
    required: true,
  },
];

function Editor({ initial }: { initial: Record<string, string> }) {
  const [values, setValues] = useState(initial);
  return (
    <NativeInputFields
      fields={fields}
      values={values}
      onChange={(id, value) =>
        setValues((previous) => ({ ...previous, [id]: value }))
      }
    />
  );
}

it.each([
  [
    "pem",
    "Operator CA certificates (PEM)",
    "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
  ],
  [
    "targets",
    "Integration origins and destination CIDRs",
    "https://api.example.test 203.0.113.0/24\nhttps://other.example.test 198.51.100.0/24",
  ],
])(
  "retains the exact %s textarea label after editing and a fresh preset mount",
  (id, label, value) => {
    const rendered = render(<Editor initial={{}} />);
    const initial = screen.getByRole("textbox", { name: label });
    fireEvent.change(initial, { target: { value } });
    const edited = screen.getByRole("textbox", { name: label });
    if (!(edited instanceof HTMLTextAreaElement))
      throw new Error("Expected the edited textarea");
    expect(edited).toBe(initial);
    expect(screen.getByLabelText(label, { exact: true })).toBe(edited);
    expect(edited.labels?.[0]?.textContent?.trim()).toBe(label);
    expect(edited.value).toBe(value);
    rendered.unmount();
    render(<Editor initial={{ [id]: value }} />);
    const restored = screen.getByRole("textbox", { name: label });
    if (!(restored instanceof HTMLTextAreaElement))
      throw new Error("Expected the restored textarea");
    expect(screen.getByLabelText(label, { exact: true })).toBe(restored);
    expect(restored.labels?.[0]?.textContent?.trim()).toBe(label);
    expect(restored.value).toBe(value);
  },
);
