import { Link } from "react-router";
import { IconDownload, IconPlus, IconUpload } from "../../components/Icons.js";
import { exportAccessBook } from "../../lib/access-book.js";
import {
  type AccessView,
  accessImportPath,
  accessIsImportCeremony,
  accessIsNewCeremony,
  accessNewPath,
} from "../../lib/access-routes.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

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

export function AccessPathbar({
  pathname,
  tab,
}: {
  pathname: string;
  tab: AccessView;
}) {
  const adding = accessIsNewCeremony(pathname);
  const importing = accessIsImportCeremony(pathname);
  // Pathbar plus is always present (guest / no Host); Host GrantsPanel keeps
  // its own button without a second guide id.
  const grantRef = useGuideTarget<HTMLAnchorElement>("access.grant-access");

  return (
    <div className="access-pathbar">
      <span className="access-pathbar__root">
        <span className="access-pathbar__seg">access</span>
        <span className="access-pathbar__sep">:/</span>
        {importing ? (
          <span className="access-pathbar__seg">import</span>
        ) : adding ? (
          <span className="access-pathbar__seg">new</span>
        ) : tab !== "grants" ? (
          <span className="access-pathbar__seg">{tab}</span>
        ) : null}
      </span>
      <div
        className="access-pathbar__keys"
        role="toolbar"
        aria-label="Access actions"
      >
        <Link
          ref={grantRef}
          className="icon-btn icon-btn--sm"
          to={accessNewPath(tab)}
          aria-label="Grant access"
          title="Grant access"
        >
          <IconPlus size={15} />
        </Link>
        <Link
          className="icon-btn icon-btn--sm"
          to={accessImportPath()}
          aria-label="Import grants"
          title="Import grants"
        >
          <IconUpload size={15} />
        </Link>
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
    </div>
  );
}
