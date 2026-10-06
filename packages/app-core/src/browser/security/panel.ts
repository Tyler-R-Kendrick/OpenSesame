import { createItem } from "@opensesame/vault-core";
import { openRetiredCredentialDecoy } from "../../lib/retired-credentials/session.js";
import { vaultStore } from "../../lib/vault/store.js";
import { PERSONAL_TOMB } from "../../lib/vfs.js";
import { type PageRuntime, securityClient } from "./client.js";
import { extensionVaultRevision, initializeExtensionVault } from "./core.js";
import { action, element, secret } from "./dom.js";
import { enrollmentPanel } from "./enrollment.js";

class SecurityPanel {
  readonly content = element("div");
  readonly hint = element("p");
  readonly password = secret("Vault password");
  readonly confirm = secret("Confirm new vault password");
  readonly client: ReturnType<typeof securityClient>;
  readonly open: HTMLButtonElement;
  readonly lock: HTMLButtonElement;
  #realm: "locked" | "real" | "synthetic" = "locked";
  #renderGeneration = 0;
  constructor(
    readonly root: HTMLElement,
    runtime: PageRuntime,
    readonly changed: (productionAllowed: boolean) => void,
    public protectedVault: boolean,
  ) {
    this.hint.setAttribute("role", "status");
    this.client = securityClient(runtime, () => {
      void this.close();
    });
    this.open = action(
      protectedVault ? "Unlock vault" : "Create vault password",
      () => this.unlock(),
      this.say,
    );
    this.lock = action("Lock vault", () => this.close(), this.say);
    vaultStore.subscribe(() => {
      if (
        vaultStore.getSnapshot().status !== "unlocked" &&
        this.#realm !== "locked"
      )
        void this.close();
    });
    root.append(
      element("h2", "Security"),
      element(
        "p",
        "Device-local vault protection and retired credential traps. External alerts require a separately configured receiver.",
      ),
      this.content,
      this.hint,
    );
  }
  say = (words: string) => {
    this.hint.textContent = words;
  };
  productionAllowed = () =>
    !this.protectedVault ||
    (this.#realm === "real" && this.client.permit() !== undefined);
  async render() {
    const generation = ++this.#renderGeneration;
    this.content.replaceChildren();
    this.changed(this.productionAllowed());
    if (this.#realm === "locked") {
      this.content.append(this.password.wrapper);
      if (!this.protectedVault) this.content.append(this.confirm.wrapper);
      this.content.append(this.open);
      return;
    }
    this.content.append(element("p", "Vault open"), this.lock);
    const list = element("ul");
    for (const item of vaultStore.getSnapshot().items)
      list.append(element("li", item.name));
    const title = element("input");
    title.setAttribute("aria-label", "Note title");
    title.maxLength = 120;
    this.content.append(
      list,
      title,
      action(
        "Add note",
        async () => {
          if (!title.value) throw new Error("Enter a note title.");
          await vaultStore.addItems([createItem("note", title.value)]);
          await this.render();
        },
        this.say,
      ),
    );
    if (this.#realm === "real") {
      const settings = await enrollmentPanel(this.say);
      if (generation === this.#renderGeneration && this.#realm === "real")
        this.content.append(settings);
      const { canaryPanel } = await import("./canary-panel.js");
      const { receiverPanel } = await import("./receiver-panel.js");
      if (generation === this.#renderGeneration && this.#realm === "real")
        this.content.append(
          canaryPanel(this.client, this.say),
          receiverPanel(this.client, this.say),
        );
    }
  }
  async unlock() {
    const submitted = this.password.input.value;
    const confirmation = this.confirm.input.value;
    this.password.input.value = "";
    this.confirm.input.value = "";
    if (!this.protectedVault) {
      if (submitted !== confirmation)
        throw new Error("The passwords do not match.");
      await vaultStore.create(submitted);
      this.protectedVault = true;
      this.open.textContent = "Unlock vault";
      vaultStore.lock();
    }
    const admission = await this.client.unlock(submitted);
    if (admission.realm === "locked")
      throw new Error(
        admission.error ?? "The password did not open this vault.",
      );
    vaultStore.loadActiveProjectScope();
    try {
      if (admission.realm === "synthetic" && admission.trap)
        await openRetiredCredentialDecoy(
          vaultStore,
          admission.trap,
          PERSONAL_TOMB,
        );
      else if (admission.realm === "real") await vaultStore.unlock(submitted);
      else throw new Error("The password did not open this vault.");
      if (!admission.permit || this.client.permit() !== admission.permit)
        throw new Error("The session closed. Authenticate again.");
      this.#realm = admission.realm;
    } catch (error) {
      this.client.lock();
      vaultStore.lock();
      throw error;
    }
    this.say("");
    await this.render();
  }
  async close() {
    this.#realm = "locked";
    this.client.lock();
    vaultStore.lock();
    this.say("");
    await this.render();
  }
  requireProduction = async () => {
    this.protectedVault =
      (await extensionVaultRevision()) !== null || this.protectedVault;
    if (!this.productionAllowed() || !(await this.client.authorize()))
      throw new Error("Unlock the real vault to use connected services.");
  };
}
/** Human security surface shared by both browser extensions. */
export async function mountSecurityPanel(
  root: HTMLElement,
  runtime: PageRuntime,
  changed: (productionAllowed: boolean) => void = () => undefined,
) {
  await initializeExtensionVault();
  vaultStore.rehydrate();
  vaultStore.loadActiveProjectScope();
  const panel = new SecurityPanel(
    root,
    runtime,
    changed,
    (await extensionVaultRevision()) !== null,
  );
  await panel.render();
  return {
    permit: panel.client.permit,
    requireProduction: panel.requireProduction,
  };
}
