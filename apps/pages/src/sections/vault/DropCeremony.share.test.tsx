import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

import {
  Ceremony,
  createClaim,
  expiryRow,
  installDropCeremonyHarness,
  makeSecret,
  store,
} from "./DropCeremony.test-support.js";
import { DEVICE_ONLY_DROP_WARNING } from "./ShareForm.js";
import { makeAccount } from "./account.test-support.js";

installDropCeremonyHarness();

describe("share ceremony on an item", () => {
  it("seals a secret with a TTL and shows the drop card, saving no item", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} />);

    const ttl = screen.getByRole("radiogroup", { name: "Opens for" });
    expect(ttl.querySelectorAll("button")).toHaveLength(3);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Keep a copy/ })).toBeNull();
    expect(screen.getByText("This browser")).toBeTruthy();
    expect(screen.getByText(DEVICE_ONLY_DROP_WARNING)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    expect(
      screen.getByText(/#token=osc_clm_clm_test\.secret&key=/),
    ).toBeTruthy();
    expect(screen.getAllByText("ABCD-EFGH")).toHaveLength(1);
    expect(document.querySelector(".qr__shortcode")).toBeNull();
    expect(screen.queryByText("s3cr3t-value")).toBeNull();
    const ready = screen.getByRole("region", { name: "Drop ready" });
    expect(ready.textContent).toMatch(/Opens for\s*1 hour/);
    expect(ready.textContent).toMatch(/Opens on\s*This browser/);
    expect(expiryRow()).not.toMatch(/left/);
    expect(ready.querySelector("p.hint")).toBeNull();
    expect(screen.queryByRole("link", { name: /drop record/i })).toBeNull();
    expect(store.saveItem).not.toHaveBeenCalled();

    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("s3cr3t-value");
  });

  it("draws nothing while closed, and a closed ceremony forgets a finished drop", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} startOpen={false} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share once" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "toggle" }));
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.queryByText("Drop ready")).toBeNull();
    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.queryByText("Drop ready")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Opens for" })).toBeTruthy();
  });

  it("takes focus on the choice in force when it opens, and Cancel closes it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Ceremony item={makeSecret()} startOpen={false} onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "1 hour" }),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("is reached and left by keyboard alone", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Ceremony item={makeSecret()} startOpen={false} onClose={onClose} />,
    );
    screen.getByRole("button", { name: "toggle" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "1 hour" }),
    );
    await user.keyboard("{ArrowRight}");
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("seals an account password the same way", async () => {
    const user = userEvent.setup();
    render(
      <Ceremony
        item={makeAccount({
          id: "itm_login",
          name: "GitHub",
          username: "octocat",
          password: "hunter2-login",
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");
    expect(store.saveItem).not.toHaveBeenCalled();
    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("hunter2-login");
  });
});
