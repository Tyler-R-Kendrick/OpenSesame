/** @vitest-environment jsdom */
/**
 * The Environments sheet against a real vault: a person with no environments
 * starts one in a press, adds a key from the vault, marks it required, gives
 * it a value, and sees the schema that generates. Values are concealed until
 * asked for, never written into the schema, and every refusal goes to the
 * tray rather than the page.
 */

import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cellOf } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { EnvironmentsSheet } from "./EnvironmentsSheet.js";
import {
  APPROVED_PLAN,
  closeVault,
  openVaultWith,
} from "./environments.test-support.js";
import { environmentSeams } from "./use-environments.js";

const seams = { ...environmentSeams };

beforeAll(() => {
  environmentSeams.usePlan = () => APPROVED_PLAN;
});

afterAll(() => {
  Object.assign(environmentSeams, seams);
});

beforeEach(async () => {
  await openVaultWith("Stripe key", "Database URL", "Spare");
});

afterEach(async () => {
  cleanup();
  clearNotices();
  await closeVault();
});

function itemNamed(name: string) {
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.name === name);
  if (!item) throw new Error(`no item ${name}`);
  return item;
}

async function startProduction() {
  const user = userEvent.setup();
  render(<EnvironmentsSheet onClose={() => undefined} />);
  await user.click(screen.getByRole("button", { name: "production" }));
  await screen.findByRole("tab", { name: "production", selected: true });
  return user;
}

async function addKey(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(
    screen.getByRole("searchbox", { name: "Add a key from the vault" }),
    name,
  );
  await user.click(screen.getByRole("button", { name }));
}

describe("the Environments sheet", () => {
  it("starts empty with the three usual environments one press away, and nothing else to do", () => {
    render(<EnvironmentsSheet onClose={() => undefined} />);
    for (const name of ["development", "staging", "production"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "New environment" }),
    ).toBeTruthy();
  });

  it("makes an environment of a press and offers the vault's items as keys", async () => {
    await startProduction();
    expect(
      screen.getByRole("searchbox", { name: "Add a key from the vault" }),
    ).toBeTruthy();
    // Nothing is a key until it is added: no rows, no schema.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByLabelText(".env.schema")).toBeNull();
  });

  it("adds a key, which then draws a row with its derived variable name", async () => {
    const user = await startProduction();
    await addKey(user, "Stripe key");
    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "STRIPE_KEY required in production" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // It is a key now, so it is no longer offered as one.
    expect(screen.queryByRole("button", { name: "Stripe key" })).toBeNull();
    expect(itemNamed("Stripe key").environments).toEqual({});
  });

  it("marks a key required, says what is missing, and clears it when a value is given", async () => {
    const user = await startProduction();
    await addKey(user, "Stripe key");
    const required = await screen.findByRole("switch", {
      name: "STRIPE_KEY required in production",
    });
    await user.click(required);
    await waitFor(() =>
      expect(required.getAttribute("aria-checked")).toBe("true"),
    );
    expect(
      await screen.findByRole("img", {
        name: "STRIPE_KEY is required in production and has no value",
      }),
    ).toBeTruthy();

    await user.type(
      screen.getByLabelText("STRIPE_KEY in production"),
      "sk_live_abc",
    );
    await waitFor(
      () =>
        expect(
          cellOf(itemNamed("Stripe key").environments, "production")?.value,
        ).toBe("sk_live_abc"),
      { timeout: 3000 },
    );
    expect(
      await screen.findByRole("img", {
        name: "STRIPE_KEY has a value in production",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: /has no value/ })).toBeNull();
  });

  it("conceals a value until it is shown, and copies it through the vault's clipboard path", async () => {
    const user = await startProduction();
    await addKey(user, "Stripe key");
    const field = await screen.findByLabelText("STRIPE_KEY in production");
    await user.type(field, "sk_live_secret");
    await waitFor(() =>
      expect(
        cellOf(itemNamed("Stripe key").environments, "production")?.value,
      ).toBe("sk_live_secret"),
    );
    expect(field.getAttribute("type")).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show STRIPE_KEY" }));
    expect(field.getAttribute("type")).toBe("text");
    await user.click(screen.getByRole("button", { name: "Copy STRIPE_KEY" }));
    expect(await navigator.clipboard.readText()).toBe("sk_live_secret");
  });

  it("generates the schema from the keys, with the rule per environment and never a value", async () => {
    const user = await startProduction();
    await user.type(
      screen.getByRole("textbox", { name: "New environment" }),
      "staging",
    );
    await user.click(screen.getByRole("button", { name: "Add environment" }));
    await screen.findByRole("tab", { name: "staging", selected: true });
    await user.click(screen.getByRole("tab", { name: "production" }));
    await addKey(user, "Stripe key");
    await user.click(
      await screen.findByRole("switch", {
        name: "STRIPE_KEY required in production",
      }),
    );
    await user.type(
      screen.getByLabelText("STRIPE_KEY in production"),
      "sk_live_hidden",
    );
    const schema = await screen.findByLabelText(".env.schema");
    await waitFor(() =>
      expect(schema.textContent).toContain(
        "# @sensitive @required=forEnv(production)\nSTRIPE_KEY=",
      ),
    );
    expect(schema.textContent).toContain(
      "# @type=enum(production, staging) @required @public",
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(schema.textContent).not.toContain("sk_live_hidden");
    await user.click(screen.getByRole("button", { name: "Copy .env.schema" }));
    expect(await navigator.clipboard.readText()).toBe(
      schema.querySelector("pre")?.textContent,
    );
  });

  it("keeps each environment's value apart when the tab changes", async () => {
    const user = await startProduction();
    await user.type(
      screen.getByRole("textbox", { name: "New environment" }),
      "staging",
    );
    await user.click(screen.getByRole("button", { name: "Add environment" }));
    await screen.findByRole("tab", { name: "staging", selected: true });
    await user.click(screen.getByRole("tab", { name: "production" }));
    await addKey(user, "Stripe key");
    await user.type(
      await screen.findByLabelText("STRIPE_KEY in production"),
      "prod-value",
    );
    await user.click(screen.getByRole("tab", { name: "staging" }));
    const staging = await screen.findByLabelText("STRIPE_KEY in staging");
    expect(staging).toHaveProperty("value", "");
    await user.type(staging, "stage-value");
    await user.click(screen.getByRole("tab", { name: "production" }));
    await waitFor(() =>
      expect(screen.getByLabelText("STRIPE_KEY in production")).toHaveProperty(
        "value",
        "prod-value",
      ),
    );
    await waitFor(() => {
      const cells = itemNamed("Stripe key").environments;
      expect(cellOf(cells, "staging")?.value).toBe("stage-value");
      expect(cellOf(cells, "production")?.value).toBe("prod-value");
    });
  });

  it("asks twice before it takes a key, or an environment, away with its values", async () => {
    const user = await startProduction();
    await addKey(user, "Stripe key");
    const remove = await screen.findByRole("button", {
      name: "Remove STRIPE_KEY from the schema",
    });
    await user.click(remove);
    const again = await screen.findByRole("button", {
      name: "Press again to take STRIPE_KEY out of every environment",
    });
    expect(itemNamed("Stripe key").environments).toEqual({});
    await user.click(again);
    await waitFor(() =>
      expect(itemNamed("Stripe key").environments).toBeUndefined(),
    );
    expect(screen.queryByText("STRIPE_KEY")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Remove production" }));
    expect(screen.getByRole("tab", { name: "production" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Press again to remove production and its values",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
    expect(screen.getByRole("button", { name: "development" })).toBeTruthy();
  });

  it("refuses a name that cannot be one, in the tray and on the field, not in the page", async () => {
    const user = userEvent.setup();
    render(<EnvironmentsSheet onClose={() => undefined} />);
    const field = screen.getByRole("textbox", { name: "New environment" });
    await user.type(field, "not valid!");
    await user.click(screen.getByRole("button", { name: "Add environment" }));
    await waitFor(() =>
      expect(field.getAttribute("aria-invalid")).toBe("true"),
    );
    expect(listNotices().map((notice) => notice.id)).toContain(
      "vault.environments.edit",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("moves between environments with the arrow keys, as a tablist does", async () => {
    const user = await startProduction();
    await user.type(
      screen.getByRole("textbox", { name: "New environment" }),
      "qa",
    );
    await user.click(screen.getByRole("button", { name: "Add environment" }));
    const qa = await screen.findByRole("tab", { name: "qa", selected: true });
    qa.focus();
    await user.keyboard("{ArrowLeft}");
    await screen.findByRole("tab", { name: "production", selected: true });
    expect(
      within(screen.getByRole("tablist")).getAllByRole("tab"),
    ).toHaveLength(2);
  });

  it("commits a value that is still being typed when the sheet closes", async () => {
    const user = await startProduction();
    await addKey(user, "Stripe key");
    await user.type(
      await screen.findByLabelText("STRIPE_KEY in production"),
      "typed-last",
    );
    cleanup();
    await act(async () => {
      await vaultStore.flushPendingWrites();
    });
    await waitFor(() =>
      expect(
        cellOf(itemNamed("Stripe key").environments, "production")?.value,
      ).toBe("typed-last"),
    );
  });
});
