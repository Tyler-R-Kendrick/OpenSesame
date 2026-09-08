import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ChangelogEvent,
  formatChangelogSummary,
  listHostChangelogPage,
} from "../../lib/changelog.js";
import {
  ensureHostSession,
  hostLocalSessionEligible,
  useIdentitySession,
} from "../../lib/identity.js";
import {
  type ConfigAccess,
  NO_CONFIG_ACCESS,
  loadConfigAccess,
} from "../../lib/secret-config-access.js";
import {
  type ConfigCompare,
  type ConfigKeyMeta,
  type ConfigSecretVersion,
  type SecretConfig,
  branchConfig,
  compareConfigs,
  deleteConfigSecret,
  formatConfigSummary,
  listConfigKeys,
  listConfigSecretVersions,
  listSecretConfigs,
  putConfigSecrets,
  rollbackConfigSecret,
} from "../../lib/secret-configs.js";
import { loadSettings } from "../../lib/settings.js";
import { useOnline } from "../../lib/use-online.js";
import { SecretConfigHeading } from "./SecretConfigHeading.js";
import {
  SecretConfigBranchForm,
  SecretConfigSetForm,
} from "./SecretConfigWriteForms.js";

import { type Flash, SecretConfigFlash } from "./SecretConfigFlash.js";

const CHANGELOG_PAGE_SIZE = 20;

/** Project-config metadata and write-only intake (ADR 0052 / WP-12). */
export function SecretConfigsPanel() {
  const online = useOnline();
  const session = useIdentitySession();
  const [access, setAccess] = useState<ConfigAccess>(NO_CONFIG_ACCESS);
  const generation = useRef(0);
  const [projectId, setProjectId] = useState(
    () => loadSettings().activeProjectId?.trim() ?? "",
  );
  const [configs, setConfigs] = useState<SecretConfig[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [keys, setKeys] = useState<ConfigKeyMeta[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");

  const [versionsFor, setVersionsFor] = useState<{
    keyName: string;
    rows: ConfigSecretVersion[];
  } | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<{
    keyName: string;
    version: number;
  } | null>(null);

  const [branchSlug, setBranchSlug] = useState("");
  const [compareWith, setCompareWith] = useState("");
  const [compared, setCompared] = useState<{
    a: string;
    b: string;
    diff: ConfigCompare;
  } | null>(null);

  const [events, setEvents] = useState<ChangelogEvent[]>([]);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  const [changelogLoaded, setChangelogLoaded] = useState(false);

  const refreshConfigs = useCallback(async () => {
    const project = projectId.trim();
    const current = ++generation.current;
    setAccess(NO_CONFIG_ACCESS);
    setConfigs([]);
    setKeys([]);
    setEvents([]);
    setVersionsFor(null);
    setCompared(null);
    if (!online || !project) return;
    setLoading(true);
    setFlash(null);
    try {
      if (hostLocalSessionEligible() || session) {
        await ensureHostSession().catch(() => undefined);
      }
      const permitted = await loadConfigAccess(project);
      if (generation.current !== current) return;
      setAccess(permitted);
      const next = permitted.metadata ? await listSecretConfigs(project) : [];
      if (generation.current !== current) return;
      setConfigs(next);
      setSelectedId((prev) =>
        prev && next.some((row) => row.id === prev)
          ? prev
          : (next[0]?.id ?? ""),
      );
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Could not load configs",
      });
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [online, projectId, session]);

  useEffect(() => {
    void refreshConfigs();
  }, [refreshConfigs]);

  const refreshKeys = useCallback(async () => {
    const current = generation.current;
    if (!selectedId || !access.keys) {
      setKeys([]);
      return;
    }
    try {
      const next = await listConfigKeys(selectedId);
      if (current === generation.current) setKeys(next);
    } catch (error) {
      if (current !== generation.current) return;
      setKeys([]);
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Could not load keys",
      });
    }
  }, [selectedId, access.keys]);

  useEffect(() => {
    setVersionsFor(null);
    setConfirmRollback(null);
    setCompared(null);
    void refreshKeys();
  }, [refreshKeys]);

  async function onSetSecret(event: FormEvent) {
    const current = generation.current;
    event.preventDefault();
    const keyName = newKeyName.trim();
    if (!access.manage || !selectedId || !keyName || !newKeyValue) return;
    setBusy(true);
    setFlash(null);
    try {
      await putConfigSecrets(selectedId, { [keyName]: newKeyValue });
      if (current !== generation.current) return;
      setFlash({ tone: "ok", text: `Set ${keyName} — value not shown again` });
      setNewKeyName("");
      await refreshKeys();
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Set failed",
      });
    } finally {
      // The write-only input never outlives the submit, success or not.
      setNewKeyValue("");
      setBusy(false);
    }
  }

  async function onUnset(keyName: string) {
    const current = generation.current;
    if (!access.manage || !selectedId) return;
    setBusy(true);
    setFlash(null);
    try {
      await deleteConfigSecret(selectedId, keyName);
      if (current !== generation.current) return;
      setFlash({ tone: "ok", text: `Unset ${keyName}` });
      if (versionsFor?.keyName === keyName) setVersionsFor(null);
      await refreshKeys();
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Unset failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onShowVersions(keyName: string) {
    const current = generation.current;
    if (!access.keys || !selectedId) return;
    setBusy(true);
    setFlash(null);
    try {
      const rows = await listConfigSecretVersions(selectedId, keyName);
      if (current !== generation.current) return;
      setVersionsFor({ keyName, rows });
      setConfirmRollback(null);
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Versions failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onRollback(keyName: string, version: number) {
    const current = generation.current;
    if (!access.manage || !selectedId) return;
    setBusy(true);
    setFlash(null);
    try {
      const rolled = await rollbackConfigSecret(selectedId, keyName, version);
      if (current !== generation.current) return;
      setConfirmRollback(null);
      await refreshKeys();
      await onShowVersions(keyName);
      if (current !== generation.current) return;
      setFlash({
        tone: "ok",
        text: `Rolled ${rolled.keyName} back to v${version} as new v${rolled.version}`,
      });
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Rollback failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onBranch(event: FormEvent) {
    const current = generation.current;
    event.preventDefault();
    const slug = branchSlug.trim();
    if (!access.manage || !selectedId || !slug) return;
    setBusy(true);
    setFlash(null);
    try {
      const child = await branchConfig(selectedId, { slug });
      if (current !== generation.current) return;
      setConfigs((prev) => [...prev, child]);
      setBranchSlug("");
      setFlash({ tone: "ok", text: `Branched into ${child.slug}` });
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Branch failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCompare() {
    const current = generation.current;
    if (!access.keys || !selectedId || !compareWith) return;
    setBusy(true);
    setFlash(null);
    try {
      const diff = await compareConfigs(selectedId, compareWith);
      if (current !== generation.current) return;
      setCompared({ a: selectedId, b: compareWith, diff });
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Compare failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onLoadChangelog(beforeSeq?: number) {
    const current = generation.current;
    const project = projectId.trim();
    if (!access.keys || !project) return;
    setBusy(true);
    setFlash(null);
    try {
      const page = await listHostChangelogPage(project, {
        limit: CHANGELOG_PAGE_SIZE,
        ...(beforeSeq === undefined ? undefined : { beforeSeq }),
      });
      if (current !== generation.current) return;
      setEvents((prev) =>
        beforeSeq === undefined ? page.events : [...prev, ...page.events],
      );
      setNextBeforeSeq(page.events.length === 0 ? null : page.nextBeforeSeq);
      setChangelogLoaded(true);
    } catch (error) {
      if (current !== generation.current) return;
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Changelog failed",
      });
    } finally {
      setBusy(false);
    }
  }

  const selected = configs.find((row) => row.id === selectedId);
  const others = configs.filter((row) => row.id !== selectedId);

  return (
    <section className="panel" aria-labelledby="secret-configs-heading">
      <SecretConfigHeading
        online={online}
        loading={loading}
        projectId={projectId}
        onRefresh={() => void refreshConfigs()}
      />

      <SecretConfigFlash flash={flash} />

      <div className="panel__body">
        <label className="field">
          <span>Project id</span>
          <input
            type="text"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="project_…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {!projectId.trim() ? (
          <p className="hint">
            Set an active project (Connectivity → Active project) to manage its
            configs.
          </p>
        ) : !access.metadata && !loading ? (
          <p className="hint">Project configs are not shared with this role.</p>
        ) : configs.length === 0 && !loading ? (
          <p className="hint">
            No configs yet for this project. Create them via Host API (
            <code>POST /api/v1/projects/&lt;id&gt;/configs</code>).
          </p>
        ) : (
          <>
            <label className="field">
              <span>Config</span>
              <select
                aria-label="Config"
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {configs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {formatConfigSummary(config)}
                  </option>
                ))}
              </select>
            </label>

            {selected ? (
              <>
                {access.keys ? (
                  <h3>Keys</h3>
                ) : (
                  <p className="hint">
                    Key names are not shared with this project role.
                  </p>
                )}
                {!access.keys ? null : keys.length === 0 ? (
                  <p className="hint">No secrets in this config yet.</p>
                ) : (
                  <ul className="list">
                    {keys.map((key) => (
                      <li key={key.keyName} className="list__row">
                        <div>
                          <strong>
                            <code>{key.keyName}</code>
                          </strong>
                          <p className="hint">
                            v{key.version}
                            {key.updatedAt ? ` · ${key.updatedAt}` : null}
                          </p>
                        </div>
                        <div className="actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => void onShowVersions(key.keyName)}
                          >
                            Versions
                          </button>
                          {access.manage ? (
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void onUnset(key.keyName)}
                            >
                              Unset
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {access.keys && versionsFor ? (
                  <>
                    <h3>
                      History of <code>{versionsFor.keyName}</code>
                    </h3>
                    <ul className="list">
                      {versionsFor.rows.map((row) => (
                        <li
                          key={`${versionsFor.keyName}:${row.version}`}
                          className="list__row"
                        >
                          <div>
                            <strong>v{row.version}</strong>
                            <p className="hint">
                              {row.deleted ? "deleted · " : ""}
                              {row.createdAt}
                              {row.actorId ? ` · ${row.actorId}` : null}
                            </p>
                          </div>
                          <div className="actions" hidden={!access.manage}>
                            {confirmRollback &&
                            confirmRollback.keyName === versionsFor.keyName &&
                            confirmRollback.version === row.version ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn--danger"
                                  disabled={busy}
                                  onClick={() =>
                                    void onRollback(
                                      versionsFor.keyName,
                                      row.version,
                                    )
                                  }
                                >
                                  Confirm rollback
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost"
                                  onClick={() => setConfirmRollback(null)}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn"
                                disabled={busy || row.deleted}
                                onClick={() =>
                                  setConfirmRollback({
                                    keyName: versionsFor.keyName,
                                    version: row.version,
                                  })
                                }
                              >
                                Rollback to v{row.version}
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {access.manage ? (
                  <SecretConfigSetForm
                    busy={busy}
                    newKeyName={newKeyName}
                    newKeyValue={newKeyValue}
                    setNewKeyName={setNewKeyName}
                    setNewKeyValue={setNewKeyValue}
                    onSetSecret={onSetSecret}
                  />
                ) : null}

                {access.manage ? (
                  <SecretConfigBranchForm
                    busy={busy}
                    branchSlug={branchSlug}
                    setBranchSlug={setBranchSlug}
                    onBranch={onBranch}
                  />
                ) : null}

                {access.keys && others.length > 0 ? (
                  <div className="set__inline">
                    <div className="field set__inline-grow">
                      <label htmlFor="secret-config-compare">
                        Compare with
                      </label>
                      <select
                        id="secret-config-compare"
                        value={compareWith}
                        onChange={(event) => setCompareWith(event.target.value)}
                      >
                        <option value="">Pick a config…</option>
                        {others.map((config) => (
                          <option key={config.id} value={config.id}>
                            {formatConfigSummary(config)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !compareWith}
                      onClick={() => void onCompare()}
                    >
                      Compare
                    </button>
                  </div>
                ) : null}

                {access.keys && compared ? (
                  <div>
                    <h3>Compare (presence + versions only)</h3>
                    <p className="hint">
                      Only in this config:{" "}
                      {compared.diff.onlyInA.length > 0
                        ? compared.diff.onlyInA.join(", ")
                        : "none"}
                    </p>
                    <p className="hint">
                      Only in the other:{" "}
                      {compared.diff.onlyInB.length > 0
                        ? compared.diff.onlyInB.join(", ")
                        : "none"}
                    </p>
                    {compared.diff.inBoth.length > 0 ? (
                      <ul className="list">
                        {compared.diff.inBoth.map((entry) => (
                          <li key={entry.keyName}>
                            <code>{entry.keyName}</code> — v{entry.aVersion} vs
                            v{entry.bVersion}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}

        {access.keys && projectId.trim() ? (
          <div>
            <h3>Change log</h3>
            {events.length > 0 ? (
              <ul className="list">
                {events.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{formatChangelogSummary(event)}</strong>
                      <div className="muted">
                        {event.occurredAt}
                        {event.actorId ? ` · ${event.actorId}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : changelogLoaded ? (
              <p className="hint">No changelog events yet.</p>
            ) : null}
            <div className="actions">
              {!changelogLoaded ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void onLoadChangelog()}
                >
                  Load change log
                </button>
              ) : nextBeforeSeq !== null ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void onLoadChangelog(nextBeforeSeq)}
                >
                  Load older
                </button>
              ) : (
                <span className="hint">No older events.</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
