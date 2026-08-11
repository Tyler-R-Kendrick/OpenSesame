import { type FormEvent, useRef, useState } from "react";
import {
  IconDownload,
  IconFolder,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconSun,
  IconTrash,
  IconUpload,
  IconX,
} from "../components/Icons.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import {
  SAMPLE_FOLDER_NAME,
  buildSample,
  sampleFolder,
} from "../lib/vault/sample.js";
import "./settings.css";

const THEMES = [
  { id: "system", label: "System", Icon: IconMonitor },
  { id: "light", label: "Light", Icon: IconSun },
  { id: "dark", label: "Dark", Icon: IconMoon },
] as const;

const AUTO_LOCK = [
  { value: 1, label: "1 minute" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 0, label: "Never" },
];

const CLIPBOARD = [
  { value: 10, label: "10 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 0, label: "Never clear" },
];

function Status({
  message,
}: { message: { tone: "ok" | "err"; text: string } | null }) {
  if (!message) return null;
  return (
    <p
      className={`note note--${message.tone}`}
      role={message.tone === "err" ? "alert" : "status"}
    >
      <span>{message.text}</span>
    </p>
  );
}

export function SettingsSection() {
  const { prefs, items, folders, header } = useVault();
  const store = useVaultStore();

  const [endpoints, setEndpoints] = useState(() => loadSettings());
  const [endpointSaved, setEndpointSaved] = useState(false);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [rekey, setRekey] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [rekeying, setRekeying] = useState(false);

  const [importPassword, setImportPassword] = useState("");
  const [dataMessage, setDataMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [newFolder, setNewFolder] = useState("");
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const sampleCount = items.filter((item) => item.sample).length;
  // Same gate as first-run create, so a re-key cannot weaken the KDF input.
  const nextStrength = estimateStrength(next);
  const nextTooWeak = next.length < 12 || nextStrength.score < 2;

  function saveEndpoints(event: FormEvent) {
    event.preventDefault();
    saveSettings({
      hostApi: endpoints.hostApi.trim().replace(/\/$/, ""),
      identityApi: endpoints.identityApi.trim().replace(/\/$/, ""),
    });
    setEndpoints(loadSettings());
    setEndpointSaved(true);
    window.setTimeout(() => setEndpointSaved(false), 3000);
  }

  async function changeMaster(event: FormEvent) {
    event.preventDefault();
    setRekey(null);
    if (next !== confirm) {
      setRekey({ tone: "err", text: "The two new entries do not match." });
      return;
    }
    setRekeying(true);
    try {
      await store.changeMasterPassword(current, next);
      setRekey({
        tone: "ok",
        text: "Master password changed. The vault key itself is unchanged, so your items were not re-encrypted.",
      });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (caught) {
      setRekey({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Could not change it.",
      });
    } finally {
      setRekeying(false);
    }
  }

  function exportVault() {
    try {
      const text = store.exportSealed();
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `opensesame-vault-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setDataMessage({
        tone: "ok",
        text: "Exported. The file is still ciphertext — it needs the master password it was sealed under.",
      });
    } catch (caught) {
      setDataMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Export failed.",
      });
    }
  }

  async function importVault(file: File) {
    setDataMessage(null);
    if (!importPassword) {
      setDataMessage({
        tone: "err",
        text: "Enter the master password that file was sealed under.",
      });
      return;
    }
    try {
      const added = await store.importSealed(await file.text(), importPassword);
      setImportPassword("");
      setDataMessage({
        tone: "ok",
        text:
          added === 0
            ? "That export contained nothing this vault was missing."
            : `Merged ${added} ${added === 1 ? "item" : "items"}.`,
      });
    } catch (caught) {
      setDataMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Import failed.",
      });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function loadSample() {
    const folder =
      folders.find((f) => f.name === SAMPLE_FOLDER_NAME) ?? sampleFolder();
    if (!folders.some((f) => f.id === folder.id)) {
      await store.addFolder(folder.name).then(async (created) => {
        await store.addItems(buildSample(created.id));
      });
    } else {
      await store.addItems(buildSample(folder.id));
    }
    setDataMessage({
      tone: "ok",
      text: "Sample items added. Every one is badged and can be removed in one action.",
    });
  }

  async function purgeSample() {
    const keep = items.filter((item) => !item.sample);
    const keepFolders = folders.filter((f) => f.name !== SAMPLE_FOLDER_NAME);
    await store.replaceAll(keep, keepFolders);
    setDataMessage({ tone: "ok", text: "Sample items removed." });
  }

  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Settings</h1>
        <p>
          Everything on this page is stored on this device. Preferences and
          endpoint URLs sit outside the encrypted vault.
        </p>
      </div>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Appearance</h2>
            <p>Follows your system by default.</p>
          </div>
        </div>
        <div className="panel__body">
          <fieldset className="set__themes" aria-label="Theme">
            {THEMES.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className="set__theme"
                aria-pressed={prefs.theme === id}
                onClick={() => store.setPrefs({ theme: id })}
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
          </fieldset>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Locking</h2>
            <p>
              Locking discards the decryption key from memory. Reopening needs
              the master password again.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <div className="set__pair">
            <div className="field">
              <label htmlFor="autolock">Lock after inactivity</label>
              <select
                id="autolock"
                value={prefs.autoLockMinutes}
                onChange={(event) =>
                  store.setPrefs({
                    autoLockMinutes: Number(event.target.value),
                  })
                }
              >
                {AUTO_LOCK.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="clipboard">Clear copied secrets after</label>
              <select
                id="clipboard"
                value={prefs.clipboardClearSeconds}
                onChange={(event) =>
                  store.setPrefs({
                    clipboardClearSeconds: Number(event.target.value),
                  })
                }
              >
                {CLIPBOARD.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.lockOnHide}
              onChange={(event) =>
                store.setPrefs({ lockOnHide: event.target.checked })
              }
            />
            <span>Lock as soon as this tab goes to the background</span>
          </label>
          <p className="hint">
            Clearing the clipboard only overwrites it if it still holds the
            value OpenSesame put there, and some browsers refuse the read that
            check needs.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Master password</h2>
            <p>
              Changing it re-wraps the vault key under a new derivation. Your
              items are not re-encrypted and nothing is re-uploaded, because
              nothing was uploaded.
            </p>
          </div>
        </div>
        <form
          className="panel__body"
          onSubmit={(event) => void changeMaster(event)}
        >
          <div className="field">
            <label htmlFor="current-master">Current master password</label>
            <input
              id="current-master"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </div>
          <div className="set__pair">
            <div className="field">
              <label htmlFor="next-master">New master password</label>
              <input
                id="next-master"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                aria-describedby="next-master-strength"
              />
              <span className="hint" id="next-master-strength">
                {next
                  ? `${nextStrength.label} · ${nextStrength.bits} bits`
                  : "At least 12 characters, Fair or better"}
              </span>
            </div>
            <div className="field">
              <label htmlFor="confirm-master">Confirm</label>
              <input
                id="confirm-master"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
          </div>
          <Status message={rekey} />
          <div className="actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={rekeying || !current || nextTooWeak}
              aria-busy={rekeying}
            >
              {rekeying ? "Re-wrapping…" : "Change master password"}
            </button>
            {header ? (
              <span className="hint">
                {header.kdf.iterations.toLocaleString()} PBKDF2-SHA256
                iterations
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Folders</h2>
            <p>Folders are part of the encrypted body, like items.</p>
          </div>
        </div>
        <div className="panel__body">
          {folders.length > 0 ? (
            <ul className="set__folders">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <IconFolder size={17} />
                  <input
                    defaultValue={folder.name}
                    aria-label={`Rename ${folder.name}`}
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name && name !== folder.name) {
                        void store.renameFolder(folder.id, name);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Delete folder ${folder.name}`}
                    title="Delete folder — its items stay in the vault"
                    onClick={() => void store.deleteFolder(folder.id)}
                  >
                    <IconX size={17} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No folders yet.</p>
          )}
          <div className="set__pair">
            <div className="field">
              <label htmlFor="new-folder">New folder</label>
              <input
                id="new-folder"
                value={newFolder}
                onChange={(event) => setNewFolder(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && newFolder.trim()) {
                    void store.addFolder(newFolder);
                    setNewFolder("");
                  }
                }}
              />
            </div>
            <div className="field set__pairbtn">
              <button
                type="button"
                className="btn"
                disabled={!newFolder.trim()}
                onClick={() => {
                  void store.addFolder(newFolder);
                  setNewFolder("");
                }}
              >
                <IconPlus size={16} />
                Add folder
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Planes</h2>
            <p>
              Where the Identity and Host APIs live. This page is static
              hosting; it cannot run either plane.
            </p>
          </div>
        </div>
        <form className="panel__body" onSubmit={saveEndpoints}>
          <div className="set__pair">
            <div className="field">
              <label htmlFor="identity-api">Identity API</label>
              <input
                id="identity-api"
                type="url"
                value={endpoints.identityApi}
                onChange={(event) =>
                  setEndpoints({
                    ...endpoints,
                    identityApi: event.target.value,
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="host-api">Host API</label>
              <input
                id="host-api"
                type="url"
                value={endpoints.hostApi}
                onChange={(event) =>
                  setEndpoints({ ...endpoints, hostApi: event.target.value })
                }
              />
            </div>
          </div>
          <div className="actions">
            <button type="submit" className="btn btn--primary">
              Save endpoints
            </button>
            {endpointSaved ? (
              <output className="chip chip--ok">Saved</output>
            ) : null}
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Backup and transfer</h2>
            <p>
              An export is the sealed body plus its key-wrapping header. Anyone
              holding it still needs the master password.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <div className="actions">
            <button type="button" className="btn" onClick={exportVault}>
              <IconDownload size={16} />
              Export encrypted vault
            </button>
          </div>

          <div className="set__pair">
            <div className="field">
              <label htmlFor="import-password">
                Master password of the file you are importing
              </label>
              <input
                id="import-password"
                type="password"
                autoComplete="off"
                value={importPassword}
                onChange={(event) => setImportPassword(event.target.value)}
              />
            </div>
            <div className="field set__pairbtn">
              <input
                ref={fileRef}
                id="import-file"
                type="file"
                accept="application/json"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importVault(file);
                }}
              />
              <label htmlFor="import-file" className="btn">
                <IconUpload size={16} />
                Choose export file
              </label>
            </div>
          </div>
          <p className="hint">
            Importing merges items this vault does not already have by id.
            Nothing is overwritten.
          </p>

          <hr className="set__rule" />

          <div className="actions">
            {sampleCount > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => void purgeSample()}
              >
                Remove {sampleCount} sample{" "}
                {sampleCount === 1 ? "item" : "items"}
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => void loadSample()}
              >
                Load sample vault
              </button>
            )}
            <span className="hint">
              Seven labelled items — including a deliberately weak and a
              deliberately reused password — so the health report has something
              true to say.
            </span>
          </div>

          <Status message={dataMessage} />
        </div>
      </section>

      <section className="panel set__danger">
        <div className="panel__head">
          <div>
            <h2>Delete this vault</h2>
            <p>
              Removes the encrypted file from this browser. There is no copy
              anywhere else unless you exported one.
            </p>
          </div>
        </div>
        <div className="panel__body">
          {confirmDestroy ? (
            <>
              <p className="note note--err">
                <span>
                  {items.length} {items.length === 1 ? "item" : "items"} will be
                  unrecoverable. Export first if you are not certain.
                </span>
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => store.destroy()}
                >
                  <IconTrash size={16} />
                  Delete permanently
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmDestroy(false)}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => setConfirmDestroy(true)}
              >
                <IconTrash size={16} />
                Delete this vault
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
