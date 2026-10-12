/**
 * What a provider's link honestly is, decided from its address alone, so a
 * label never claims more than the page behind it delivers.
 *
 * A catalog row's `docs_url` is documentation of the product the row names.
 * A page on fnox's site documents fnox's own backend for that product, not the
 * product, and a bare marketing homepage is a website, not documentation. Both
 * used to be drawn as "<Name> documentation".
 */
export type DocLink = {
  url: string;
  /** What the link reads as in a list of links. */
  label: string;
  /** What it reads as on a small key, where the provider's name is already in view. */
  short: string;
};

const FNOX_HOST = "fnox.jdx.dev";

/** A host whose front page is itself documentation, not a marketing page. */
const DOCS_HOST = /^(docs?|developers?|dev|learn|help|support|api|platform)\./;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isFnoxLink(url: string): boolean {
  return parse(url)?.hostname === FNOX_HOST;
}

function isBareHomepage(link: URL): boolean {
  return (
    (link.pathname === "/" || link.pathname === "") &&
    link.search === "" &&
    link.hash === "" &&
    !DOCS_HOST.test(link.hostname)
  );
}

/** The honest label for a provider link, or `null` when there is no usable address. */
export function docLink(name: string, url: string | null): DocLink | null {
  const link = url ? parse(url) : null;
  if (!url || !link || link.protocol !== "https:") return null;
  if (link.hostname === FNOX_HOST)
    return { url, label: "fnox documentation", short: "fnox docs" };
  if (isBareHomepage(link))
    return { url, label: `${name} website`, short: "Website" };
  return { url, label: `${name} documentation`, short: "Docs" };
}
