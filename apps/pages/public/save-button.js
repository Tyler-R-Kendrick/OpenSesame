/**
 * Save in OpenSesame
 *
 * <opensesame-save-button
 *   data-opensesame-type="login"
 *   vault-url="https://vault.example"
 *   value="<base64 save request>">
 * </opensesame-save-button>
 *
 * The request never leaves the browser: the button opens the static vault in a
 * popup and hands the Base64 payload to it over postMessage after a handshake.
 * The vault shows a review sheet; nothing is saved without a person pressing
 * Save.
 */

export function encodeSaveRequest(request) {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const ITEM_TYPES = new Set(["login", "credit-card", "crypto-wallet"]);
const READY = "opensesame.save.ready";
const REQUEST = "opensesame.save.request";
const SAVED = "opensesame.save.saved";
const FAILED = "opensesame.save.failed";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The secret travels in the postMessage payload, so the vault must be TLS.
 * Plain HTTP is allowed only on loopback, where the browser's own network
 * cannot be read or rewritten by anyone else.
 */
function secureVaultUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  // Query and fragment are not part of the vault origin contract, and the
  // save URL is built from the pathname only. Refuse them rather than let an
  // integrator think they were carried.
  if (url.search || url.hash) return null;
  if (url.protocol === "https:") return url;
  if (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  )
    return url;
  return null;
}

const STYLE = `
  :host { all: initial; display: inline-block; font: 600 14px/1.2 system-ui, sans-serif; }
  button {
    align-items: center; border: 1px solid #1f5eff; border-radius: 6px;
    background: #1f5eff; color: #fff; cursor: pointer; display: inline-flex;
    gap: 8px; padding: 10px 14px; font: inherit;
  }
  button:hover { filter: brightness(1.06); }
  button:disabled { cursor: not-allowed; opacity: .6; }
  button[data-theme="dark"] { background: #0b1220; border-color: #0b1220; }
  .mark { font-size: 15px; line-height: 1; }
  .status { color: #5c6370; font-weight: 400; margin-left: 8px; }
`;

export class OpenSesameSaveButton extends HTMLElement {
  static observedAttributes = [
    "value",
    "data-opensesame-type",
    "vault-url",
    "label",
    "data-theme",
  ];

  #button;
  #status;
  #popup = null;
  #timer = 0;
  #onMessage = (event) => this.#receive(event);

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.#button = document.createElement("button");
    this.#button.type = "button";
    this.#status = document.createElement("span");
    this.#status.className = "status";
    this.#status.setAttribute("role", "status");
    this.#button.addEventListener("click", () => this.#open());
    root.append(style, this.#button, this.#status);
  }

  connectedCallback() {
    this.#render();
  }

  disconnectedCallback() {
    this.#close();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.#render();
  }

  #render() {
    const label = this.getAttribute("label") || "Save in OpenSesame";
    this.#button.textContent = label;
    this.#button.dataset.theme = this.getAttribute("data-theme") || "light";
    this.#button.disabled = !this.#ready();
    if (!this.#ready() && !this.#status.textContent) {
      this.#status.textContent =
        this.getAttribute("value") &&
        ITEM_TYPES.has(this.getAttribute("data-opensesame-type") || "")
          ? "vault-url must be https (http only on loopback)"
          : "Add value and vault-url";
    }
  }

  #ready() {
    return (
      Boolean(this.getAttribute("value")) &&
      ITEM_TYPES.has(this.getAttribute("data-opensesame-type") || "") &&
      secureVaultUrl(this.getAttribute("vault-url")) !== null
    );
  }

  #open() {
    if (!this.#ready()) return;
    const vault = secureVaultUrl(this.getAttribute("vault-url"));
    if (!vault) {
      this.#status.textContent =
        "vault-url must be https (http is allowed only on loopback)";
      return;
    }
    const base = new URL(
      vault.pathname.endsWith("/") ? vault.pathname : `${vault.pathname}/`,
      vault,
    );
    const saveUrl = new URL("save", base);
    window.addEventListener("message", this.#onMessage);
    const popup = window.open(
      saveUrl.toString(),
      "opensesame-save",
      "popup=yes,width=520,height=720",
    );
    if (!popup) {
      window.removeEventListener("message", this.#onMessage);
      this.#status.textContent = "Allow the vault popup, then try again";
      return;
    }
    this.#popup = popup;
    this.#status.textContent = "Opening vault…";
    this.#timer = window.setTimeout(() => {
      this.#status.textContent = "The vault did not answer";
      this.#close();
    }, 10 * 60_000);
  }

  #receive(event) {
    if (!this.#popup || event.source !== this.#popup) return;
    let origin;
    try {
      origin = new URL(this.getAttribute("vault-url")).origin;
    } catch {
      return;
    }
    if (event.origin !== origin) return;
    const data = event.data;
    if (data === null || data === undefined || Object(data) !== data) return;
    if (data.type === READY) {
      window.clearTimeout(this.#timer);
      this.#timer = 0;
      this.#popup.postMessage(
        {
          type: REQUEST,
          request: this.getAttribute("value"),
          itemType: this.getAttribute("data-opensesame-type"),
        },
        origin,
      );
      this.#status.textContent = "Review in the vault";
      return;
    }
    if (data.type === SAVED) {
      this.#status.textContent = "Saved";
      this.#button.textContent = "Saved in OpenSesame";
      this.dispatchEvent(
        new CustomEvent("opensesame-saved", {
          bubbles: true,
          composed: true,
          detail: { itemId: data.itemId ?? null },
        }),
      );
      this.#close();
      return;
    }
    if (data.type === FAILED) {
      this.#status.textContent =
        data.message === undefined ? "Save failed" : String(data.message);
      this.#close();
    }
  }

  #close() {
    window.removeEventListener("message", this.#onMessage);
    window.clearTimeout(this.#timer);
    this.#popup = null;
  }
}

if (!customElements.get("opensesame-save-button")) {
  customElements.define("opensesame-save-button", OpenSesameSaveButton);
}
