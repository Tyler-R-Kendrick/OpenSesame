import "@opensesame/app-core/browser/security/security.css";
/**
 * The owner's local runner settings and candidate recovery UI.
 * Settings stay device-sealed; each operation retains its original page ticket.
 * Legacy no-vault settings remain usable without upgrading into a real session.
 * Backup plaintext and generated private keys require fresh real owner authority;
 * a bare install must create or unlock its vault before generating a key.
 */
import { startSecurityPanel } from "@opensesame/app-core/browser/security/bootstrap.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  type CredentialForm,
  type FormError,
  entryFromForm,
} from "../../runner/credential-form";
import { resolveHostBase } from "../../runner/host-base";
import { pageOperations } from "../../runner/options-operations";
import { optionsRecovery } from "../../runner/options-recovery";
import { matchPattern } from "../../runner/origin";
import {
  type OriginalOwner,
  originalPageOperation,
} from "../../runner/original-owner";
import type { RunnerStatus } from "../../runner/service";
import { browserStore } from "../../runner/store";

const security = startSecurityPanel(
  el("security"),
  browser.runtime,
  (allowed) => {
    el("production-controls").hidden = !allowed;
    if (allowed)
      setTimeout(() => {
        void render().catch(() => {});
      }, 0);
    else {
      el("revealed").textContent = "";
      el<HTMLTextAreaElement>("recovery-private").value = "";
      el<HTMLTextAreaElement>("reveal-key").value = "";
      say("");
      for (const id of [
        "ready",
        "pass",
        "credentials",
        "armed",
        "held",
        "drive-origin",
      ])
        el(id).replaceChildren();
      for (const id of ["token", "recovery-public"])
        el<HTMLInputElement | HTMLTextAreaElement>(id).value = "";
      el<HTMLFormElement>("credential").reset();
      el("recovery-private-field").hidden = true;
    }
  },
);
const mutate = pageOperations({ security, raw: browserStore, say });

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return overlapCast(found);
}

function say(text: string) {
  const hint = el("hint");
  hint.hidden = text === "";
  hint.textContent = text;
}

interface Row {
  text: string;
  ok?: boolean;
  /** A secondary action on the row: its label and what it does. */
  action?: [string, () => void];
}

function rows(list: HTMLElement, items: Row[]) {
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      if (item.ok !== undefined) li.dataset.ok = String(item.ok);
      const span = document.createElement("span");
      span.textContent = item.text;
      li.append(span);
      if (item.action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = item.action[0];
        button.addEventListener("click", item.action[1]);
        li.append(button);
      }
      return li;
    }),
  );
}

async function status(owner: OriginalOwner): Promise<RunnerStatus | null> {
  await owner.authorize();
  owner.check();
  const reply = overlapCast(
    await browser.runtime.sendMessage({
      securityPermit: owner.permit,
      type: "opensesame.runner.status",
    }),
  );
  owner.check();
  await owner.authorize();
  owner.check();
  return reply && !reply.error ? overlapCast(reply) : null;
}

async function arm(origin: string, owner: OriginalOwner) {
  await owner.authorize();
  owner.check();
  const reply = overlapCast(
    await browser.runtime.sendMessage({
      securityPermit: owner.permit,
      type: "opensesame.runner.arm",
      origin,
    }),
  );
  owner.check();
  await owner.authorize();
  owner.check();
  say(
    reply.result === "armed"
      ? `Driving ${origin} for 30 minutes.`
      : `Not armed: ${reply.result ?? reply.error}.`,
  );
  owner.check();
  await render(owner);
}

async function disarm(origin: string, owner: OriginalOwner) {
  await owner.authorize();
  owner.check();
  await browser.runtime.sendMessage({
    securityPermit: owner.permit,
    type: "opensesame.runner.disarm",
    origin,
  });
  owner.check();
  await render(owner);
}

async function render(owner = originalPageOperation(security)) {
  const now = await status(owner);
  owner.check();
  if (!now) {
    say("The background worker did not answer.");
    return;
  }
  rows(el("ready"), [
    { text: "Host session", ok: now.session },
    {
      text: "Private window allowed (to prove a login)",
      ok: now.privateAllowed,
    },
    { text: "Recovery key pinned (to back a candidate up)", ok: now.recovery },
    {
      text: `Credentials held: ${now.credentials.length}`,
      ok: now.credentials.length > 0,
    },
  ]);
  const pass = now.lastPass;
  if (pass) {
    const why = pass.error ?? pass.skipped.join(", ");
    rows(el("pass"), [
      {
        text: `Last pass: ${pass.driven} driven, ${pass.settled} steps${why ? `, ${why}` : ""}`,
        ok: pass.error === null,
      },
    ]);
  }
  rows(
    el("credentials"),
    now.credentials.map((origin) => ({
      text: origin,
      action: [
        "Remove",
        () =>
          void mutate(
            async (operation, scoped) => {
              await scoped.vault.removeEntry(origin);
              operation.check();
              await render(operation);
            },
            undefined,
            owner,
          ),
      ],
    })),
  );
  const choice = el<HTMLSelectElement>("drive-origin");
  choice.replaceChildren(
    ...now.credentials.map((origin) => new Option(origin, origin)),
  );
  rows(
    el("armed"),
    now.armed.map((row) => ({
      text: `${row.origin} until ${new Date(row.expiresAt).toLocaleTimeString()}${row.granted ? "" : " (browser grant removed)"}`,
      ok: row.granted,
      action: [
        "Stop",
        () =>
          void mutate(
            async (operation) => disarm(row.origin, operation),
            undefined,
            owner,
          ),
      ],
    })),
  );
  rows(
    el("held"),
    now.candidates.map((candidate) => ({
      text: `${candidate.origin} · ${candidate.state} · ${candidate.handle}`,
      action: [
        "Recover",
        () =>
          void mutate(async () => recover(candidate.handle), undefined, owner),
      ],
    })),
  );
}

const recovery = optionsRecovery({
  security,
  raw: browserStore,
  resolveBase: resolveHostBase,
  element: el,
  say,
  render,
});
export const recover = recovery.recover;
export const createOwnerRecoveryKey = recovery.createOwnerRecoveryKey;

function describe(error: FormError): string {
  switch (error) {
    case "origin":
      return "The origin must be https, or http on this machine.";
    case "password":
      return "A password is required.";
    case "login_url":
      return "The login URL must be on the same origin.";
    case "login_selector":
      return "A selector does not parse.";
    case "login_incomplete":
      return "A login check needs its URL and three selectors.";
  }
}

function readForm(form: HTMLFormElement): CredentialForm {
  const data = new FormData(form);
  const field = (name: string) => String(data.get(name) ?? "");
  return {
    origin: field("origin"),
    username: field("username"),
    password: field("password"),
    loginUrl: field("loginUrl"),
    usernameSelector: field("usernameSelector"),
    passwordSelector: field("passwordSelector"),
    submitSelector: field("submitSelector"),
    signedInSelector: field("signedInSelector"),
    rejectedSelector: field("rejectedSelector"),
  };
}

const parses = (selector: string) => {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
};

export async function saveCredential(form: HTMLFormElement) {
  await mutate(async (owner, scoped) => {
    const result = entryFromForm(readForm(form), parses);
    if (!result.ok) {
      say(describe(result.error));
      return;
    }
    await scoped.vault.putEntry(result.entry);
    owner.check();
    form.reset();
    say("Credential saved.");
    await render(owner);
  }, "This browser cannot keep the credential.");
}
el("credential").addEventListener("submit", (event) => {
  event.preventDefault();
  const form: HTMLFormElement = overlapCast(event.currentTarget);
  void saveCredential(form);
});
export async function saveToken() {
  await mutate(async (owner, scoped) => {
    const input = el<HTMLInputElement>("token");
    if (input.value.trim() === "") return;
    await scoped.settings.setToken(input.value);
    owner.check();
    input.value = "";
    say("Session saved.");
    await render(owner);
  }, "This browser cannot keep the session.");
}
el("token-save").addEventListener("click", () => void saveToken());
el("token-clear").addEventListener(
  "click",
  () =>
    void mutate(async (owner, scoped) => {
      await scoped.settings.clearToken();
      owner.check();
      await render(owner);
    }),
);
export async function pinRecovery() {
  await mutate(async (owner, scoped) => {
    const field = el<HTMLTextAreaElement>("recovery-public");
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(field.value);
    } catch {
      say("That is not JSON.");
      return;
    }
    const pinned = await scoped.vault.setRecipient(jwk);
    owner.check();
    say(
      pinned
        ? "Recovery key pinned."
        : "That is not a public RSA-OAEP key of 3072 bits or more.",
    );
    if (pinned) field.value = "";
    await render(owner);
  });
}
el("recovery-pin").addEventListener("click", () => void pinRecovery());

el("recovery-create").addEventListener(
  "click",
  () => void createOwnerRecoveryKey(),
);

el("drive-arm").addEventListener("click", () => {
  const owner = originalPageOperation(security);
  const origin = el<HTMLSelectElement>("drive-origin").value;
  if (origin === "") return;
  // The browser's own prompt, on this click and for this one origin.
  void security
    .requireProduction()
    .then(() => {
      owner.check();
      return browser.permissions.request({
        permissions: ["scripting"],
        origins: [matchPattern(origin)],
      });
    })
    .then(async (granted) => {
      owner.check();
      await owner.authorize();
      owner.check();
      if (granted) await arm(origin, owner);
      else say("The browser did not grant that site.");
    })
    .catch(() => {
      /* Revoked consent cannot arm or publish successor UI. */
    });
});

void security.ready.catch(() => {
  el("production-controls").hidden = true;
  say("Security settings could not be initialized.");
});
