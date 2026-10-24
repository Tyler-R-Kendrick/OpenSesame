import type { SealedKv } from "../../runner/store";
import { vaultSecurityPage } from "../../runner/vault-app";
export function bindVaultAppNavigation(
  kv: SealedKv,
  say: (text: string) => void,
) {
  const field = document.querySelector<HTMLInputElement>("#vault-app-url");
  const save = document.getElementById("vault-app-save");
  const open = document.querySelector<HTMLAnchorElement>(
    "#vault-security-open",
  );
  if (!field || !save || !open) return;
  const show = (value: string | null) => {
    open.hidden = !value;
    open.removeAttribute("href");
    if (!value) return;
    open.href = vaultSecurityPage(value);
    field.value = value;
  };
  void kv
    .get("vault.app")
    .then(show)
    .catch(() =>
      say("The saved vault app could not be opened. Set its address again."),
    );
  save.addEventListener("click", () => {
    const value = field.value.trim();
    void Promise.resolve()
      .then(async () => {
        vaultSecurityPage(value);
        await kv.set("vault.app", value);
        show(value);
        say(
          "Vault app saved. Review retired passwords there with your current vault key.",
        );
      })
      .catch(() =>
        say("Enter your vault app's HTTPS base URL, or HTTP on localhost."),
      );
  });
}
