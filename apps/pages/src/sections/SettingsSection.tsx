import {
  type ComponentType,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { FieldShell } from "../components/FieldShell.js";
import {
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconLock,
  IconLogin,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconSun,
  IconTrash,
  IconUpload,
  IconX,
} from "../components/Icons.js";
import { StatusNote } from "../components/StatusNote.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import {
  defaultPassphraseOptions,
  estimateStrength,
  generate,
} from "../lib/vault/password.js";
import {
  SAMPLE_FOLDER_NAME,
  buildSample,
  sampleFolder,
} from "../lib/vault/sample.js";
import {
  type StorePlainEntry,
  planManifestMerge,
  vaultItemToEntry,
} from "../lib/vault/store-sync.js";
import { ActiveProjectPanel as DefaultActiveProjectPanel } from "./settings/ActiveProjectPanel.js";
import { CapabilityConnectorsPanel as DefaultCapabilityConnectorsPanel } from "./settings/CapabilityConnectorsPanel.js";
import { ChangelogPanel as DefaultChangelogPanel } from "./settings/ChangelogPanel.js";
import { CoreConnectionsPanel } from "./settings/CoreConnectionsPanel.js";
import { EndpointsPanel, TursoSyncPanel } from "./settings/EndpointsPanel.js";
import { GithubBackupPanel as DefaultGithubBackupPanel } from "./settings/GithubBackupPanel.js";
import { ImportPanel as DefaultImportPanel } from "./settings/ImportPanel.js";
import { OfflineBackupPanel as DefaultOfflineBackupPanel } from "./settings/OfflineBackupPanel.js";
import { SyncTargetsPanel as DefaultSyncTargetsPanel } from "./settings/SyncTargetsPanel.js";
import { TaskBusPanel as DefaultTaskBusPanel } from "./settings/TaskBusPanel.js";
import { UnlockMethodsPanel as DefaultUnlockMethodsPanel } from "./settings/UnlockMethodsPanel.js";
import "./settings.css";
import { overlapCast } from "@opensesame/os-domain";

const THEMES = [
  { id: "system", label: "System", Icon: IconMonitor },
  { id: "light", label: "Light", Icon: IconSun },
  { id: "dark", label: "Dark", Icon: IconMoon },
] as const;

/**
 * These read inside a sentence, so each option carries its own preposition —
 * "after 30 minutes idle", not "30 minutes". That is what keeps every
 * combination grammatical, including the two that mean "never".
 */
const AUTO_LOCK = [
  { value: 0, label: "only when I ask" },
  { value: 60, label: "after 1 hour idle" },
  { value: 240, label: "after 4 hours idle" },
  { value: 480, label: "after 8 hours idle" },
  { value: 1440, label: "after 24 hours idle" },
  { value: 30, label: "after 30 minutes idle" },
  { value: 15, label: "after 15 minutes idle" },
  { value: 5, label: "after 5 minutes idle" },
  { value: 1, label: "after 1 minute idle" },
];

const CLIPBOARD = [
  { value: 10, label: "for 10 seconds" },
  { value: 30, label: "for 30 seconds" },
  { value: 60, label: "for 1 minute" },
  { value: 0, label: "until something replaces them" },
];

/**
 * Say what the selected auto-lock actually does, rather than covering every
 * case at once in a paragraph nobody finishes.
 */
function autoLockExplainer(minutes: number): string {
  if (minutes === 0) {
    return "Nothing locks on a timer. Closing this window already drops the key from memory, which is why leaving this alone is the recommended setting.";
  }
  const span =
    minutes < 60
      ? `${minutes} minutes`
      : minutes === 60
        ? "an hour"
        : minutes === 1440
          ? "a full day"
          : `${minutes / 60} hours`;
  return `After ${span} idle the vault key is dropped. You stay signed in to Host and Identity — only the vault needs unlocking again.`;
}

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

export type SettingsPanels = {
  UnlockMethodsPanel: ComponentType;
  ActiveProjectPanel: ComponentType;
  CapabilityConnectorsPanel: ComponentType;
  SyncTargetsPanel: ComponentType;
  TaskBusPanel: ComponentType;
  GithubBackupPanel: ComponentType;
  ChangelogPanel: ComponentType;
  OfflineBackupPanel: ComponentType;
  ImportPanel: ComponentType;
};

const defaultPanels: SettingsPanels = {
  UnlockMethodsPanel: DefaultUnlockMethodsPanel,
  ActiveProjectPanel: DefaultActiveProjectPanel,
  CapabilityConnectorsPanel: DefaultCapabilityConnectorsPanel,
  SyncTargetsPanel: DefaultSyncTargetsPanel,
  TaskBusPanel: DefaultTaskBusPanel,
  GithubBackupPanel: DefaultGithubBackupPanel,
  ChangelogPanel: DefaultChangelogPanel,
  OfflineBackupPanel: DefaultOfflineBackupPanel,
  ImportPanel: DefaultImportPanel,
};

/** `#import` predates the categories and deep-links into Vault data. */
function categoryFromHash(hash: string): CategoryId | null {
  const raw = hash.replace(/^#/, "");
  if (raw === "import" || raw === "github-backup") return "data";
  if (raw === "taskbus") return "connectivity";
  const match = CATEGORIES.find((category) => category.id === raw);
  return match ? match.id : null;
}

export function SettingsSection({
  panels = defaultPanels,
}: {
  panels?: Partial<SettingsPanels>;
} = {}) {
  const resolvedPanels = { ...defaultPanels, ...panels };
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
    const id = hash.replace(/^#/, "");
    if (id === "github-backup" || id === "import") {
      window.requestAnimationFrame(() => {
        document
          .getElementById(id)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [hash]);

  function selectCategory(next: CategoryId) {
    setCategory(next);
    navigate(`#${next}`, { replace: true });
  }

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [showNext, setShowNext] = useState(false);
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
        text: "Downloaded a plaintext path manifest for the unlocked vault. Seal it with `opensesame pass seal <file> --shred` — never commit the manifest itself.",
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
      const parsed = overlapCast(JSON.parse(await file.text()));
      if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON array of store entries.");
      }
      // Merge by store path — re-importing the same manifest must not
      // duplicate the vault.
      const plan = planManifestMerge(parsed, items, folders);
      await store.applyManifestMerge(plan);
      setDataMessage({
        tone: "ok",
        text: `Merged ${parsed.length} sealed-store ${parsed.length === 1 ? "entry" : "entries"}: ${plan.adds.length} added, ${plan.updates.length} updated, ${plan.unchanged} unchanged.`,
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

  async function changeMaster(event: FormEvent) {
    event.preventDefault();
    setRekey(null);
    setRekeying(true);
    try {
      await store.changeMasterPassword(current, next);
      setRekey({
        tone: "ok",
        text: "Master password changed. The vault key itself is unchanged, so your items were not re-encrypted.",
      });
      setCurrent("");
      setNext("");
      setShowNext(false);
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
                  Locking discards the vault decryption key from memory. Closing
                  this window already does that.
                </p>
              </div>
            </div>
            <div className="panel__body">
              <p className="sent">
                Lock the vault{" "}
                <select
                  aria-label="Lock after inactivity"
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
                . Copied secrets stay in the clipboard{" "}
                <select
                  aria-label="Clear copied secrets after"
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
                .
              </p>
              <p className="why">{autoLockExplainer(prefs.autoLockMinutes)}</p>
              <div className="sw">
                <span className="sw__name">
                  Lock when this tab goes to the background
                </span>
                <button
                  type="button"
                  className="toggle"
                  role="switch"
                  aria-checked={prefs.lockOnHide}
                  aria-pressed={prefs.lockOnHide}
                  aria-label="Lock when this tab goes to the background"
                  onClick={() =>
                    store.setPrefs({ lockOnHide: !prefs.lockOnHide })
                  }
                />
              </div>
              <div className="sw">
                <span>
                  <span className="sw__name">Sign out of Identity too</span>
                  <span className="sw__sub">
                    {" "}
                    — strict. Auto-lock otherwise only drops the vault key and
                    leaves you signed in to Host and Identity.
                  </span>
                </span>
                <button
                  type="button"
                  className="toggle"
                  role="switch"
                  aria-checked={prefs.signOutOnLock}
                  aria-pressed={prefs.signOutOnLock}
                  aria-label="Also sign out of Identity when the vault locks"
                  onClick={() =>
                    store.setPrefs({ signOutOnLock: !prefs.signOutOnLock })
                  }
                />
              </div>
            </div>
          </section>
        </>
      )}

      {category !== "security" ? null : <resolvedPanels.UnlockMethodsPanel />}

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
            <FieldShell
              id="current-master"
              label="Current"
              type="password"
              autoComplete="current-password"
              lead={<IconLock size={17} />}
              value={current}
              disabled={!header?.wrap}
              onValueChange={setCurrent}
            />
            <FieldShell
              id="next-master"
              label="New password"
              type={showNext ? "text" : "password"}
              autoComplete="new-password"
              lead={<IconLogin size={17} />}
              mono={showNext}
              value={next}
              disabled={!header?.wrap}
              onValueChange={setNext}
              tail={
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Suggest a strong password"
                    title="Suggest a strong password"
                    disabled={!header?.wrap}
                    onClick={() => {
                      setNext(generate(defaultPassphraseOptions));
                      setShowNext(true);
                    }}
                  >
                    <IconRefresh size={17} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={showNext ? "Hide password" : "Show password"}
                    aria-pressed={showNext}
                    onClick={() => setShowNext((value) => !value)}
                  >
                    {showNext ? (
                      <IconEyeOff size={17} />
                    ) : (
                      <IconEye size={17} />
                    )}
                  </button>
                </>
              }
            />
            {/* No Confirm field. Confirm exists because the value is masked;
                the value is shown here, so re-typing it proves nothing. */}
            <div className="str">
              <div className="str__bars" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((slot) => (
                  <span
                    key={slot}
                    className="str__bar"
                    style={
                      next && slot <= nextStrength.score
                        ? { background: `var(--s-${nextStrength.score})` }
                        : undefined
                    }
                  />
                ))}
              </div>
              <p className="str__read" id="next-master-strength">
                {next ? (
                  <>
                    <span
                      className="str__label"
                      style={{ color: `var(--s-${nextStrength.score})` }}
                    >
                      {nextStrength.label}
                    </span>
                    <span className="str__bits">{nextStrength.bits} bits</span>
                  </>
                ) : (
                  <span className="hint">
                    At least 12 characters, Fair or better
                  </span>
                )}
              </p>
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

      {category !== "connectivity" ? null : <CoreConnectionsPanel />}

      {category !== "connectivity" ? null : <resolvedPanels.ActiveProjectPanel />}

      {category !== "connectivity" ? null : <resolvedPanels.CapabilityConnectorsPanel />}

      {category !== "connectivity" ? null : <resolvedPanels.SyncTargetsPanel />}

      {category !== "connectivity" ? null : <resolvedPanels.TaskBusPanel />}

      {category !== "connectivity" ? null : <TursoSyncPanel />}

      {category !== "connectivity" ? null : <EndpointsPanel />}

      {category !== "data" ? null : <resolvedPanels.GithubBackupPanel />}

      {category !== "data" ? null : <resolvedPanels.ChangelogPanel />}

      {category !== "data" ? null : <resolvedPanels.OfflineBackupPanel />}

      {category !== "data" ? null : <resolvedPanels.ImportPanel />}

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
              CLI:{" "}
              <code>
                {
                  "opensesame pass init --remote \u003cgit url\u003e \u0026\u0026 opensesame pass seal manifest.json --shred \u0026\u0026 opensesame pass backup"
                }
              </code>
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
