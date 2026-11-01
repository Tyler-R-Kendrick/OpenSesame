const REPO_URL = "https://github.com/OpenSesame-Labs/OpenSesame";

type AboutLink = {
  readonly label: string;
  readonly href: string;
};

/** Project documentation links for the "About this project" row. */
const ABOUT_LINKS: readonly AboutLink[] = [
  { label: "What it is", href: `${REPO_URL}/blob/main/README.md` },
  {
    label: "Install / getting started",
    href: `${REPO_URL}/blob/main/docs/getting-started/README.md`,
  },
  {
    label: "Configure",
    href: `${REPO_URL}/blob/main/docs/getting-started/README.md`,
  },
  { label: "Contribute", href: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
  {
    label: "Report a vulnerability",
    href: `${REPO_URL}/blob/main/SECURITY.md`,
  },
  {
    label: "Open a private advisory",
    href: `${REPO_URL}/security/advisories/new`,
  },
  { label: "Report a bug", href: `${REPO_URL}/issues` },
  { label: "Changelog", href: `${REPO_URL}/blob/main/docs/CHANGELOG.md` },
  { label: "License: MIT", href: `${REPO_URL}/blob/main/LICENSE` },
  { label: "Source code", href: REPO_URL },
];

/** Project navigation belongs in the unlocked Support sheet, never at a gate. */
export function ProjectLinks() {
  return (
    <details className="support__project">
      <summary tabIndex={0}>About this project</summary>
      <ul className="support__project-links">
        {ABOUT_LINKS.map((link) => (
          <li key={link.label}>
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
