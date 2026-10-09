/**
 * The local runner's options page: the person's own credential store, their
 * Host session, the recovery key a candidate is backed up to, and the one site
 * they let the runner drive right now.
 *
 * Everything written here goes through the same sealed store the background
 * reads (`runner/store.ts`, ADR 0149). A secret is only ever typed into a
 * write-only field and cleared once saved; nothing on this page shows a stored
 * value. The one reveal is the recovery of a backed-up candidate, which needs
 * the private key the person holds and shows the value to them alone.
 */
import { createApiClient } from "@opensesame/api-client";
import { overlapCast } from "@opensesame/os-domain";
import { backupId, createRecoveryKey, openBackup } from "../../runner/backup";
import {
  type CredentialForm,
  type FormError,
  entryFromForm,
} from "../../runner/credential-form";
import { recoverBackup } from "../../runner/host";
import { resolveHostBase } from "../../runner/host-base";
import { matchPattern } from "../../runner/origin";
import type { RunnerStatus } from "../../runner/service";
import { RunnerSettings } from "../../runner/settings";
import { SealedKv, browserStore } from "../../runner/store";
import { RunnerVault } from "../../runner/vault";

const kv = new SealedKv(browserStore());
const settings = new RunnerSettings(kv);
const vault = new RunnerVault(kv);

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

async function status(): Promise<RunnerStatus | null> {
  const reply = overlapCast(
    await browser.runtime.sendMessage({ type: "opensesame.runner.status" }),
  );
  return reply && !reply.error ? overlapCast(reply) : null;
}

async function arm(origin: string) {
  const reply = overlapCast(
    await browser.runtime.sendMessage({
      type: "opensesame.runner.arm",
      origin,
    }),
  );
  say(
    reply.result === "armed"
      ? `Driving ${origin} for 30 minutes.`
      : `Not armed: ${reply.result ?? reply.error}.`,
  );
  await render();
}

async function disarm(origin: string) {
  await browser.runtime.sendMessage({
    type: "opensesame.runner.disarm",
    origin,
  });
  await render();
}

async function render() {
  const now = await status();
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
      action: ["Remove", () => void vault.removeEntry(origin).then(render)],
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
      action: ["Stop", () => void disarm(row.origin)],
    })),
  );
  rows(
    el("held"),
    now.candidates.map((candidate) => ({
      text: `${candidate.origin} · ${candidate.state} · ${candidate.handle}`,
      action: ["Recover", () => void recover(candidate.handle)],
    })),
  );
}

/** Open a candidate's backup with the private key the person pasted. */
async function recover(handle: string) {
  const out = el("revealed");
  out.textContent = "";
  const token = await settings.token();
  if (!token) {
    say("Needs a Host session.");
    return;
  }
  try {
    const client = createApiClient({
      baseUrl: await resolveHostBase(),
      accessToken: token,
    });
    const bytes = await recoverBackup(client, backupId(handle));
    if (!bytes) {
      say("The Host holds no backup for that candidate.");
      return;
    }
    const key: JsonWebKey = JSON.parse(
      el<HTMLTextAreaElement>("reveal-key").value,
    );
    out.textContent = await openBackup(key, bytes);
    say("Shown for 30 seconds.");
    setTimeout(() => {
      out.textContent = "";
    }, 30_000);
  } catch {
    say("That key does not open this backup.");
  }
}

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

el("credential").addEventListener("submit", (event) => {
  event.preventDefault();
  const form: HTMLFormElement = overlapCast(event.currentTarget);
  const result = entryFromForm(readForm(form), parses);
  if (!result.ok) {
    say(describe(result.error));
    return;
  }
  void vault
    .putEntry(result.entry)
    .then(() => {
      form.reset();
      say("Credential saved.");
      return render();
    })
    .catch(() => say("This browser cannot keep the credential."));
});

el("token-save").addEventListener("click", () => {
  const input = el<HTMLInputElement>("token");
  if (input.value.trim() === "") return;
  void settings
    .setToken(input.value)
    .then(() => {
      input.value = "";
      say("Session saved.");
      return render();
    })
    .catch(() => say("This browser cannot keep the session."));
});
el("token-clear").addEventListener("click", () => {
  void settings.clearToken().then(render);
});

el("recovery-pin").addEventListener("click", () => {
  const field = el<HTMLTextAreaElement>("recovery-public");
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(field.value);
  } catch {
    say("That is not JSON.");
    return;
  }
  void vault.setRecipient(jwk).then((pinned) => {
    say(
      pinned
        ? "Recovery key pinned."
        : "That is not a public RSA-OAEP key of 3072 bits or more.",
    );
    if (pinned) field.value = "";
    return render();
  });
});

el("recovery-create").addEventListener("click", () => {
  void createRecoveryKey().then(async (pair) => {
    await vault.setRecipient(pair.recipient.jwk);
    el<HTMLTextAreaElement>("recovery-private").value = JSON.stringify(
      pair.privateJwk,
    );
    el("recovery-private-field").hidden = false;
    say("Recovery key pinned. Save the private key now; it is not kept.");
    await render();
  });
});

el("drive-arm").addEventListener("click", () => {
  const origin = el<HTMLSelectElement>("drive-origin").value;
  if (origin === "") return;
  // The browser's own prompt, on this click and for this one origin.
  void browser.permissions
    .request({ permissions: ["scripting"], origins: [matchPattern(origin)] })
    .then((granted) =>
      granted ? arm(origin) : say("The browser did not grant that site."),
    );
});

void render();
