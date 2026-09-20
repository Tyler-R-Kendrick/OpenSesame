import { type ComponentType, type FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { FieldShell } from "../components/FieldShell.js";
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconLogin,
  IconRefresh,
  IconTrash,
  IconX,
} from "../components/Icons.js";
import { StatusNote } from "../components/StatusNote.js";
import {
  type SettingsCategory,
  settingsCategoryFromHash,
  settingsCategoryFromLocation,
  settingsPath,
} from "../lib/crumbs.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import {
  defaultPassphraseOptions,
  estimateStrength,
  generate,
} from "../lib/vault/password.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { AgeKeysPanel } from "./settings/AgeKeysPanel.js";
import { FeatureBindingsPanel } from "./settings/FeatureBindingsPanel.js";
import { GeneralPrefsPanel } from "./settings/GeneralPrefsPanel.js";
import { InstallPanel as DefaultInstallPanel } from "./settings/InstallPanel.js";
import { KeybindingsViewsPanel } from "./settings/KeybindingsViewsPanel.js";
import { ModelProviderPanel as DefaultModelProviderPanel } from "./settings/ModelProviderPanel.js";
import { SettingsRawEditor } from "./settings/SettingsRawEditor.js";
import { SettingsViewToggle } from "./settings/SettingsViewToggle.js";
import { UnlockMethodsPanel as DefaultUnlockMethodsPanel } from "./settings/UnlockMethodsPanel.js";
import { VaultsPanel as DefaultVaultsPanel } from "./settings/VaultsPanel.js";
import { WalletPassPanel as DefaultWalletPassPanel } from "./settings/WalletPassPanel.js";
import type { RawFormat } from "./settings/settings-files.js";
import "./settings.css";
export const settingsTabs = [
  { id: "general", label: "General", guideId: "settings.general" },
  { id: "security", label: "Security", guideId: "settings.security" },
  { id: "vaults", label: "Vaults", guideId: "settings.vaults" },
  {
    id: "connections",
    label: "Connections",
    guideId: "settings.connections",
  },
  { id: "danger", label: "Danger", guideId: "settings.danger" },
] as const satisfies readonly {
  id: SettingsCategory;
  label: string;
  guideId: string;
}[];

/** One category link, named so a guide can point at it. */
function CategoryLink({
  guideId,
  to,
  label,
  danger,
  current,
}: {
  guideId: string;
  to: string;
  label: string;
  danger: boolean;
  current: boolean;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(guideId);
  return (
    <Link
      ref={ref}
      to={to}
      className={`set__nav-link${danger ? " set__nav-link--danger" : ""}`}
      aria-current={current ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

type CategoryId = SettingsCategory;

export type SettingsPanels = {
  UnlockMethodsPanel: ComponentType;
  WalletPassPanel: ComponentType;
  InstallPanel: ComponentType;
  ModelProviderPanel: ComponentType;
  VaultsPanel: ComponentType;
};

const defaultPanels: SettingsPanels = {
  UnlockMethodsPanel: DefaultUnlockMethodsPanel,
  WalletPassPanel: DefaultWalletPassPanel,
  InstallPanel: DefaultInstallPanel,
  ModelProviderPanel: DefaultModelProviderPanel,
  VaultsPanel: DefaultVaultsPanel,
};

function categoryFromHash(hash: string): CategoryId | null {
  return settingsCategoryFromHash(hash);
}

export function SettingsSection({
  panels = defaultPanels,
}: {
  panels?: Partial<SettingsPanels>;
} = {}) {
  const resolvedPanels = { ...defaultPanels, ...panels };
  const { items, header } = useVault();
  const store = useVaultStore();
  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const category = settingsCategoryFromLocation(pathname, hash);
  const [representation, setRepresentation] = useState<"form" | RawFormat>(
    "form",
  );

  // Legacy hashes rewrite onto rest paths so refresh and crumbs agree.
  useEffect(() => {
    const fromHash = categoryFromHash(hash);
    if (fromHash && !pathname.match(/\/settings\/[^/]+/)) {
      navigate(settingsPath(fromHash, hash), { replace: true });
    }
  }, [hash, navigate, pathname]);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [showNext, setShowNext] = useState(false);
  const [rekey, setRekey] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [rekeying, setRekeying] = useState(false);

  const rekeyRef = useGuideTarget<HTMLButtonElement>(
    "settings.master-password",
  );

  const [confirmDestroy, setConfirmDestroy] = useState(false);

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

  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Settings</h1>
        <SettingsViewToggle
          representation={representation}
          onChange={setRepresentation}
        />
      </div>

      <nav className="set__nav" aria-label="Settings sections">
        {settingsTabs.map((entry) => (
          <CategoryLink
            key={entry.id}
            guideId={entry.guideId}
            to={settingsPath(entry.id)}
            label={entry.label}
            danger={entry.id === "danger"}
            current={category === entry.id}
          />
        ))}
      </nav>
      {representation === "yaml" || representation === "toml" ? (
        <SettingsRawEditor category={category} format={representation} />
      ) : null}
      {representation !== "form" || category !== "connections" ? null : (
        <FeatureBindingsPanel
          ModelProviderPanel={resolvedPanels.ModelProviderPanel}
        />
      )}
      {representation !== "form" || category !== "general" ? null : (
        <>
          <GuideTarget id="settings.install">
            <resolvedPanels.InstallPanel />
          </GuideTarget>
          <GeneralPrefsPanel />
          <KeybindingsViewsPanel />
        </>
      )}

      {representation !== "form" || category !== "security" ? null : (
        <resolvedPanels.UnlockMethodsPanel />
      )}
      {representation !== "form" || category !== "security" ? null : (
        <AgeKeysPanel />
      )}
      {representation !== "form" || category !== "security" ? null : (
        <resolvedPanels.WalletPassPanel />
      )}

      {representation !== "form" || category !== "security" ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Master password</h2>
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
                ref={rekeyRef}
                type="submit"
                className="icon-btn"
                disabled={rekeying || !header?.wrap || !current || nextTooWeak}
                aria-busy={rekeying}
                aria-label="Change master password"
                title="Change master password"
              >
                <IconLock size={16} />
              </button>
            </div>
          </form>
        </section>
      )}

      {representation !== "form" || category !== "vaults" ? null : (
        <resolvedPanels.VaultsPanel />
      )}

      {representation !== "form" || category !== "danger" ? null : (
        <section className="panel set__danger">
          <div className="panel__head">
            <div>
              <h2>Delete this vault</h2>
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
                    className="icon-btn icon-btn--danger is-armed"
                    aria-label="Delete permanently"
                    title="Delete permanently"
                    onClick={() => void store.destroy()}
                  >
                    <IconTrash size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Cancel"
                    title="Cancel"
                    onClick={() => setConfirmDestroy(false)}
                  >
                    <IconX size={16} />
                  </button>
                </div>
              </>
            ) : (
              <div className="actions">
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  aria-label="Delete this vault"
                  title="Delete this vault"
                  onClick={() => setConfirmDestroy(true)}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
