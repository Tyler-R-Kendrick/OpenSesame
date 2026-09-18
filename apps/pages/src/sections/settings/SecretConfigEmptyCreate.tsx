import { type FormEvent, useState } from "react";
import { createSecretConfig } from "../../lib/secret-configs.js";

export function SecretConfigEmptyCreate(props: {
  projectId: string;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createSecretConfig(props.projectId, {
        slug: slug.trim() || "default",
        environment: "development",
      });
      props.onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="set__inline" onSubmit={(event) => void onCreate(event)}>
      <p className="hint">No configs yet for this project.</p>
      <div className="field set__inline-grow">
        <label htmlFor="secret-config-create-slug">New config slug</label>
        <input
          id="secret-config-create-slug"
          value={slug}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setSlug(event.target.value)}
        />
      </div>
      <button type="submit" className="btn btn--primary" disabled={busy}>
        Create config
      </button>
      {error ? (
        <p className="hint" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
