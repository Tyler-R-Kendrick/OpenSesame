import {
  exportAccessBook,
  importAccessBook,
} from "@opensesame/app-core/lib/access-book.js";
import { isString } from "@opensesame/os-domain";
import { useState } from "react";
import { IconDownload, IconUpload } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

function exportBook() {
  const url = URL.createObjectURL(
    new Blob([exportAccessBook()], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "access.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

type Outcome = { tone: "ok" | "err"; label: string };

function readBook(file: File, done: (outcome: Outcome) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { added } = importAccessBook(
        isString(reader.result) ? reader.result : "",
      );
      done(
        added === 0
          ? { tone: "err", label: "No new grants in that file" }
          : {
              tone: "ok",
              label: `Imported ${added} grant${added === 1 ? "" : "s"}`,
            },
      );
    } catch (caught) {
      done({
        tone: "err",
        label:
          caught instanceof Error
            ? caught.message
            : "That file is not an access book",
      });
    }
  };
  reader.onerror = () =>
    done({ tone: "err", label: "Could not read that file" });
  reader.readAsText(file);
}

/**
 * The access book's two keys, at the end of Access's title row: import and
 * export move the portable grants listed on Grants. They sat in a path strip
 * of their own (`access:/`, which the tab and the rail already say) that put
 * Access's tabs 75px below Identity's and Wallet's. It had a + too, for a
 * Host grant ceremony that no longer exists — it changed the path to
 * `access:/new` and opened nothing. Each panel's own + adds its kind (a
 * share, a request). Import is the file chooser itself.
 */
export function AccessPathbar({ onImported }: { onImported: () => void }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  return (
    <div
      className="access-pathbar__keys"
      role="toolbar"
      aria-label="Access actions"
    >
      {outcome ? (
        <StatusMark tone={outcome.tone} label={outcome.label} />
      ) : null}
      <label
        className="icon-btn icon-btn--sm access-pathbar__file"
        title="Import grants"
      >
        <IconUpload size={15} />
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Import grants"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            readBook(file, (next) => {
              setOutcome(next);
              if (next.tone === "ok") onImported();
            });
          }}
        />
      </label>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Export grants"
        title="Export grants"
        onClick={exportBook}
      >
        <IconDownload size={15} />
      </button>
    </div>
  );
}
