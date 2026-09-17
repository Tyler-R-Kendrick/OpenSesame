import { isString } from "@opensesame/os-domain";
import { useRef, useState } from "react";
import { IconAlert, IconUpload } from "../../components/Icons.js";
import { importAccessBook } from "../../lib/access-book.js";

export function ImportAccessCeremony({ onDone }: { onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = isString(reader.result) ? reader.result : "";
      try {
        const { added } = importAccessBook(raw);
        if (added === 0) {
          setError("No new grants in that file.");
          return;
        }
        onDone();
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "That file is not an access book.",
        );
      }
    };
    reader.onerror = () => {
      setError("Could not read that file.");
    };
    reader.readAsText(file);
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Import grants</h2>
        </div>
      </div>
      <div className="panel__body access-add-kinds">
        <button
          type="button"
          className="icon-btn"
          aria-label="Import from a file"
          title="Import from a file"
          onClick={() => inputRef.current?.click()}
        >
          <IconUpload size={16} />
        </button>
        <span className="go-verb">File</span>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            onFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}
    </section>
  );
}
