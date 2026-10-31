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
import { makeAccount } from "./account.test-support.js";

installDropCeremonyHarness();

describe("share ceremony on an item", () => {
  it("seals a secret with a TTL and shows the portable drop card, saving no item", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} />);

    const ttl = screen.getByRole("radiogroup", { name: "Suggested window" });
    expect(ttl.querySelectorAll("button")).toHaveLength(3);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Keep a copy/ })).toBeNull();
    expect(screen.getByText("Any browser with the link and code")).toBeTruthy();
    expect(screen.queryByText(/Only this browser can open/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    expect(
      screen.getByText(/#token=osc_pdrop_.*&key=.*&pkt=ospd2\.packet/),
    ).toBeTruthy();
    expect(screen.getAllByText("ABCD-EFGH")).toHaveLength(1);
    expect(document.querySelector(".qr__shortcode")).toBeNull();
    expect(screen.queryByText("s3cr3t-value")).toBeNull();
    expect(screen.queryByText("Contains the password.")).toBeNull();
    const ready = screen.getByRole("region", { name: "Drop ready" });
    expect(ready.textContent).toMatch(/Suggested window\s*1 hour/);
    expect(ready.textContent).toMatch(/Opens on\s*Any browser with the link/);
    expect(expiryRow()).not.toMatch(/left/);
    expect(ready.querySelector("p.hint")?.textContent).toContain(
      "It cannot be revoked.",
    );
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
    expect(
      screen.getByRole("radiogroup", { name: "Suggested window" }),
    ).toBeTruthy();
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

  it("warns that the share-text copy contains the password", async () => {
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

    const row = screen.getByText("Share text").closest(".frow");
    expect(row?.textContent).toContain("Contains the password.");
    expect(row?.querySelector("span.hint")?.textContent).toBe(
      "Contains the password.",
    );
    expect(screen.queryByText("hunter2-login")).toBeNull();
    expect(screen.getByText("octocat")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy share text" }),
    ).toBeTruthy();
  });
});
