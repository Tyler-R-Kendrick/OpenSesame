/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  NativeConnectorFields,
  NativeInputFields,
} from "./NativeConnectorFields.js";
import type {
  NativeField,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

afterEach(cleanup);

it.each([
  [
    "same labels",
    "Browser access evidence",
    "https://docs.example.test/browser/first",
    "https://docs.example.test/browser/second",
  ],
  [
    "same URLs",
    "Provider documentation",
    "https://docs.example.test/browser/same",
    "https://docs.example.test/browser/same",
  ],
  [
    "normalized URLs",
    "Provider documentation",
    "https://docs.example.test:443/browser/same",
    "https://docs.example.test/browser/same",
  ],
])(
  "keeps focused evidence on its URL through %s, reordering and updates",
  async (_case, firstLabel, first, second) => {
    const label = "Browser access evidence";
    const alias = second.replace(
      "docs.example.test/",
      "docs.example.test:443/",
    );
    const method: NativeMethodDescriptor = {
      id: "api-key",
      label: "API key",
      available: true,
      fields: [],
      scopeGroups: [],
      links: [
        { label: firstLabel, url: first },
        { label, url: second },
        { label, url: alias },
      ],
    };
    const fields = (links: NativeMethodDescriptor["links"]) => (
      <NativeConnectorFields
        method={{ ...method, links }}
        values={{}}
        scopes={{}}
        onValue={() => undefined}
        onScopes={() => undefined}
      />
    );
    const warnings = vi.spyOn(console, "error");
    try {
      const view = render(fields(method.links));
      expect(screen.getAllByRole("link")).toHaveLength(2);
      const evidence = screen.getAllByRole("link")[1];
      await userEvent.tab();
      await userEvent.tab();
      expect(document.activeElement).toBe(evidence);
      expect(evidence).toHaveProperty("href", second);
      view.rerender(
        fields([
          { label, url: second },
          { label: firstLabel, url: first },
          { label, url: alias },
        ]),
      );
      expect(document.activeElement).toBe(evidence);
      expect(evidence).toHaveProperty("href", second);
      view.rerender(
        fields([
          { label, url: "https://docs.example.test/browser/new" },
          { label, url: second },
          { label: "Updated provider page", url: first },
          { label, url: alias },
        ]),
      );
      expect(document.activeElement).toBe(evidence);
      expect(evidence).toHaveProperty("href", second);
      expect(evidence.textContent).toContain(label);
      expect(screen.getAllByRole("link")).toHaveLength(3);
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
    }
  },
);

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
