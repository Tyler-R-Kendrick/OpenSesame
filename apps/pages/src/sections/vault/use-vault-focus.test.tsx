/** @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { useVaultFocus } from "./use-vault-focus.js";

function pane(html: string): HTMLElement {
  const node = document.createElement("div");
  node.innerHTML = html;
  document.body.append(node);
  return node;
}

const wrapper = ({ children }: { children?: ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

function mount() {
  const tree = pane('<div role="tree" tabindex="0">tree</div>');
  const list = pane("<div></div>");
  const detail = pane("<div></div>");
  renderHook(
    () =>
      useVaultFocus({
        tree: { current: tree },
        list: { current: list },
        detail: { current: detail },
        newItem: { current: null },
      }),
    { wrapper },
  );
  return tree;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the vault's arrival focus", () => {
  it("lands on the tree when nothing else holds the caret", () => {
    const tree = mount();
    expect(document.activeElement).toBe(tree.querySelector('[role="tree"]'));
  });

  it("yields to a dialog that already holds the caret", () => {
    const dialog = pane(
      '<section role="dialog" aria-modal="false"><button type="button">Next</button></section>',
    );
    const next = dialog.querySelector("button");
    next?.focus();
    mount();
    expect(document.activeElement).toBe(next);
  });
});
