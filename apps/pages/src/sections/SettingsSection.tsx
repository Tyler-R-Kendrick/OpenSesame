import { type FormEvent, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
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
import { ConnectThisMachine } from "../components/PlaneNote.js";
import { StatusNote } from "../components/StatusNote.js";
import { checkTurso, setTursoSessionToken } from "../lib/embedded-catalog.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import {
  SAMPLE_FOLDER_NAME,
  buildSample,
  sampleFolder,
} from "../lib/vault/sample.js";
import {
  type StorePlainEntry,
  entriesToVaultItems,
  vaultItemToEntry,
} from "../lib/vault/store-sync.js";
import { CapabilityConnectorsPanel } from "./settings/CapabilityConnectorsPanel.js";
import { ImportPanel } from "./settings/ImportPanel.js";
import { UnlockMethodsPanel } from "./settings/UnlockMethodsPanel.js";
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

/**
 * Settings is a lot of unrelated panels; one wall of scroll buries them all.
 * Each panel belongs to exactly one category, and only the active category
 * renders.
 */
const CATEGORIES = [
  { id: "general", label: "General" },
  { id: "security", label: "Security" },
  { id: "connectivity", label: "Connectivity" },
  { id: "data", label: "Vault data" },
  { id: "danger", label: "Danger" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

/** `#import` predates the categories and deep-links into Vault data. */
function categoryFromHash(hash: string): CategoryId | null {
  const raw = hash.replace(/^#/, "");
  if (raw === "import") return "data";
  const match = CATEGORIES.find((category) => category.id === raw);
  return match ? match.id : null;
}

export function SettingsSection() {
  const { prefs, items, folders, header } = useVault();
  const store = useVaultStore();
  const { hash } = useLocation();
  const navigate = useNavigate();

  const [category, setCategory] = useState<CategoryId>(
    () => categoryFromHash(hash) ?? "general",
  );

  // Links elsewhere in the app land on a category via the hash (`#import`
  // from the vault's empty state, `#connectivity` from plane notes, …).
  useEffect(() => {
    const fromHash = categoryFromHash(hash);
    if (fromHash) setCategory(fromHash);
  }, [hash]);

  function selectCategory(next: CategoryId) {
    setCategory(next);
    navigate(`#${next}`, { replace: true });
  }

  const [endpoints, setEndpoints] = useState(() => loadSettings());
  const [endpointSaved, setEndpointSaved] = useState(false);
  const [tursoToken, setTursoToken] = useState("");
  const [databaseStatus, setDatabaseStatus] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

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
  const storeFileRef = useRef<HTMLInputElement>(null);

  function exportStoreManifest() {
    try {
      const active = items.filter((item) => item.deletedAt === null);
      const entries = active.map((item) => vaultItemToEntry(item, folders));
      const text = `${JSON.stringify(entries, null, 2)}\n`;
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `opensesame-store-manifest-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setDataMessage({
        tone: "ok",
        text: "Downloaded a plaintext path manifest for the unlocked vault. Seal it with `opensesame pass insert` / your store tooling — do not commit this file.",
      });
    } catch (caught) {
      setDataMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Export failed.",
      });
    }
  }

  async function importStoreManifest(file: File) {
    setDataMessage(null);
    try {
      const parsed = JSON.parse(await file.text()) as StorePlainEntry[];
      if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON array of store entries.");
      }
      const { items: incoming, folders: plannedFolders } = entriesToVaultItems(
        parsed,
        folders,
      );
      const nameToId = new Map(
        folders.map((f) => [f.name.trim().toLowerCase(), f.id] as const),
      );
      for (const folder of plannedFolders) {
        const key = folder.name.trim().toLowerCase();
        if (nameToId.has(key)) continue;
        const created = await store.addFolder(folder.name);
        nameToId.set(key, created.id);
      }
      const remapped = incoming.map((item) => {
        if (!item.folderId) return item;
        const planned = plannedFolders.find((f) => f.id === item.folderId);
        if (!planned) return item;
        const id = nameToId.get(planned.name.trim().toLowerCase());
        return id ? { ...item, folderId: id } : item;
      });
      await store.addItems(remapped);
      setDataMessage({
        tone: "ok",
        text: `Merged ${remapped.length} sealed-store ${remapped.length === 1 ? "entry" : "entries"} into this device vault.`,
      });
    } catch (caught) {
      setDataMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Import failed.",
      });
    } finally {
      if (storeFileRef.current) storeFileRef.current.value = "";
    }
  }

  const [newFolder, setNewFolder] = useState("");
  const [sampleMessage, setSampleMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const sampleCount = items.filter((item) => item.sample).length;
  // Same gate as first-run create, so a re-key cannot weaken the KDF input.
  const nextStrength = estimateStrength(next);
  const nextTooWeak = next.length < 12 || nextStrength.score < 2;

  async function saveEndpoints(event: FormEvent) {
    event.preventDefault();
    saveSettings({
      hostApi: endpoints.hostApi.trim().replace(/\/$/, ""),
      identityApi: endpoints.identityApi.trim().replace(/\/$/, ""),
      daemonApi: endpoints.daemonApi.trim().replace(/\/$/, ""),
      tursoUrl: endpoints.tursoUrl.trim(),
      mfaAppUrl: endpoints.mfaAppUrl.trim().replace(/\/$/, ""),
      capabilityConnectors: loadSettings().capabilityConnectors,
    });
    setTursoSessionToken(tursoToken);
    const mode = await checkTurso();
    setEndpoints(loadSettings());
    setDatabaseStatus({
      tone: mode === "memory" ? "err" : "ok",
      text:
        mode === "remote"
          ? "Turso is embedded in this PWA and synchronized with the configured remote."
          : mode === "embedded"
            ? "Turso is running inside this PWA and persisting the connector catalog in OPFS."
            : "Turso could not open; this tab is using the bundled connector catalog in memory.",
    });
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
    setSampleMessage({
      tone: "ok",
      text: "Sample items added. Every one is badged and can be removed in one action.",
    });
  }

  async function purgeSample() {
    const keep = items.filter((item) => !item.sample);
    const keepFolders = folders.filter((f) => f.name !== SAMPLE_FOLDER_NAME);
    await store.replaceAll(keep, keepFolders);
    setSampleMessage({ tone: "ok", text: "Sample items removed." });
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

      <nav className="set__nav" aria-label="Settings sections">
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`set__nav-link${entry.id === "danger" ? " set__nav-link--danger" : ""}`}
            aria-current={category === entry.id ? "true" : undefined}
            onClick={() => selectCategory(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {category !== "general" ? null : (
        <>
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
                  Locking discards the decryption key from memory. Reopening
                  needs the master password again.
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
                value OpenSesame put there, and some browsers refuse the read
                that check needs.
              </p>
            </div>
          </section>
        </>
      )}

      {category !== "security" ? null : <UnlockMethodsPanel />}

      {category !== "security" ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Master password</h2>
              <p>
                Changing it re-wraps the vault key under a new derivation. Your
                items are not re-encrypted and nothing is re-uploaded, because
                nothing was uploaded. Passkey and PIN unlocks stay enrolled.
              </p>
            </div>
          </div>
          <form
            className="panel__body"
            onSubmit={(event) => void changeMaster(event)}
          >
            {!header?.wrap || !header?.kdf ? (
              <p className="hint">
                This vault has no master-password unlock. Enroll one under
                Unlock methods, or change unlock methods there.
              </p>
            ) : null}
            <div className="field">
              <label htmlFor="current-master">Current master password</label>
              <input
                id="current-master"
                type="password"
                autoComplete="current-password"
                value={current}
                disabled={!header?.wrap}
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
                  disabled={!header?.wrap}
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
                  disabled={!header?.wrap}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </div>
            </div>
            <StatusNote message={rekey} />
            <div className="actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={rekeying || !header?.wrap || !current || nextTooWeak}
                aria-busy={rekeying}
              >
                {rekeying ? "Re-wrapping…" : "Change master password"}
              </button>
              {header?.kdf ? (
                <span className="hint">
                  {header.kdf.iterations.toLocaleString()} PBKDF2-SHA256
                  iterations
                </span>
              ) : null}
            </div>
          </form>
        </section>
      )}

      {category !== "data" ? null : (
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
            <form
              className="set__inline"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newFolder.trim()) return;
                void store.addFolder(newFolder);
                setNewFolder("");
              }}
            >
              <div className="field set__inline-grow">
                <label htmlFor="new-folder">New folder</label>
                <input
                  id="new-folder"
                  value={newFolder}
                  placeholder="e.g. Work"
                  onChange={(event) => setNewFolder(event.target.value)}
                />
              </div>
              <button
                type="submit"
                className="btn"
                disabled={!newFolder.trim()}
              >
                <IconPlus size={16} />
                Add folder
              </button>
            </form>
          </div>
        </section>
      )}

      {category !== "connectivity" ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Planes</h2>
              <p>
                Where the Identity and Host APIs live. GitHub Pages cannot run
                either plane. Locally they auto-connect. Remotely, pair the
                daemon on this machine or paste a Host you run.
              </p>
            </div>
          </div>
          <div className="panel__body">
            <ConnectThisMachine />
          </div>
          <form
            className="panel__body"
            onSubmit={(event) => void saveEndpoints(event)}
          >
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
                  placeholder="http://127.0.0.1:8787"
                  onChange={(event) =>
                    setEndpoints({ ...endpoints, hostApi: event.target.value })
                  }
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="daemon-api">Daemon on this machine</label>
              <input
                id="daemon-api"
                type="url"
                value={endpoints.daemonApi}
                placeholder="http://127.0.0.1:18790"
                onChange={(event) =>
                  setEndpoints({ ...endpoints, daemonApi: event.target.value })
                }
              />
              <p className="hint">
                Local Pages keep Host/Identity on loopback after pairing. The
                Tailscale Serve URL is stored for github.io / other devices.
                From github.io, paste{" "}
                <code>https://machine.tailnet.ts.net</code> here (this page
                cannot call 127.0.0.1).
              </p>
            </div>
            <div className="field">
              <label htmlFor="mfa-app-url">Mobile MFA app (optional)</label>
              <input
                id="mfa-app-url"
                type="url"
                value={endpoints.mfaAppUrl}
                placeholder="http://127.0.0.1:5177"
                onChange={(event) =>
                  setEndpoints({ ...endpoints, mfaAppUrl: event.target.value })
                }
              />
              <p className="hint">
                When this browser cannot finish a passkey, Authority shows a QR
                that opens this URL on your phone.
              </p>
            </div>
            <div className="set__pair">
              <div className="field">
                <label htmlFor="turso-url">Turso sync URL (optional)</label>
                <input
                  id="turso-url"
                  type="url"
                  placeholder="libsql://database-name.turso.io"
                  value={endpoints.tursoUrl}
                  onChange={(event) =>
                    setEndpoints({ ...endpoints, tursoUrl: event.target.value })
                  }
                />
                <p className="hint">
                  Blank keeps the database entirely inside this PWA. A URL plus
                  a token enables explicit Turso push/pull sync.
                </p>
              </div>
              <div className="field">
                <label htmlFor="turso-token">
                  Turso auth token (this tab only)
                </label>
                <input
                  id="turso-token"
                  type="password"
                  autoComplete="off"
                  placeholder="Only needed for remote sync"
                  value={tursoToken}
                  onChange={(event) => setTursoToken(event.target.value)}
                />
                <p className="hint">
                  Never written to OPFS or the vault. Paste it again after a
                  reload when remote sync is needed.
                </p>
              </div>
            </div>
            <StatusNote message={databaseStatus} />
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
      )}

      {category !== "connectivity" ? null : <CapabilityConnectorsPanel />}

      {category !== "data" ? null : <ImportPanel />}

      {category !== "data" ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Git sealed store</h2>
              <p>
                Bridge this device vault with an <code>opensesame</code> sealed
                store (<code>~/.password-store</code> or{" "}
                <code>OPENSESAME_STORE_DIR</code>). Manifests are plaintext
                while unlocked — seal them with the CLI before committing to
                git. Use{" "}
                <strong>Connectivity → Capability connectors → History</strong>{" "}
                to authorize GitHub as the default remote for encrypted history.
                Agents never receive these values; they use ConnectionRefs only.
              </p>
            </div>
          </div>
          <div className="panel__body">
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={exportStoreManifest}
              >
                <IconDownload size={16} />
                Download store path manifest
              </button>
              <input
                ref={storeFileRef}
                id="store-manifest-file"
                type="file"
                accept="application/json"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importStoreManifest(file);
                }}
              />
              <label htmlFor="store-manifest-file" className="btn">
                <IconUpload size={16} />
                Import store path manifest
              </label>
            </div>
            <p className="hint">
              CLI: <code>opensesame pass init && opensesame pass insert …</code>
            </p>
          </div>
        </section>
      )}

      {category !== "data" ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Backup and move to another device</h2>
              <p>
                An OpenSesame export is the sealed body plus its key-wrapping
                header. Anyone holding it still needs the master password. This
                is not the same as the import above, which reads other products'
                plaintext exports.
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

            <div className="set__inline">
              <div className="field set__inline-grow">
                <label htmlFor="import-password">
                  Master password that export was sealed under
                </label>
                <input
                  id="import-password"
                  type="password"
                  autoComplete="off"
                  value={importPassword}
                  onChange={(event) => setImportPassword(event.target.value)}
                />
              </div>
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
                Choose an OpenSesame export
              </label>
            </div>
            <p className="hint">
              Importing merges items this vault does not already have by id.
              Nothing is overwritten.
            </p>

            <StatusNote message={dataMessage} />
          </div>
        </section>
      )}

      {category !== "data" ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Sample data</h2>
              <p>
                Opt-in demonstration items, every row badged SYNTHETIC. Includes
                a weak and a reused password so health has something true to
                say.
              </p>
            </div>
          </div>
          <div className="panel__body">
            <div className="actions">
              {sampleCount > 0 ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void purgeSample()}
                >
                  Remove {sampleCount} SYNTHETIC{" "}
                  {sampleCount === 1 ? "item" : "items"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadSample()}
                >
                  Load SYNTHETIC sample items
                </button>
              )}
              <span className="hint">One action removes them all.</span>
            </div>
            <StatusNote message={sampleMessage} />
          </div>
        </section>
      )}

      {category !== "danger" ? null : (
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
                    {items.length} {items.length === 1 ? "item" : "items"} will
                    be unrecoverable. Export first if you are not certain.
                  </span>
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => void store.destroy()}
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
      )}
    </div>
  );
}
