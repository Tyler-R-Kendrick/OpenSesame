/**
 * Who may ask the runner anything: this extension's own pages, and nothing else.
 *
 * The runner holds the authority to drive a signed-in site, so a message from a
 * content script (whose `url` is the web page's), from another extension (a
 * different `id`), or with no `url` at all is not answered. The base ends in a
 * slash, so `chrome-extension://abc` cannot be mistaken for `…://abcd`.
 */
import { isString } from "@opensesame/os-domain";

/** Who sent a message, as far as the runner asks. */
export interface MessageSender {
  id?: string;
  url?: string;
}

export function isOwnPage(
  sender: MessageSender,
  ownId: string,
  ownBase: string,
): boolean {
  return (
    sender.id === ownId &&
    isString(sender.url) &&
    ownBase.endsWith("/") &&
    sender.url.startsWith(ownBase)
  );
}
