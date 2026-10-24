import type { BrowserNodeRequests } from "./controller-requests.js";

type RetiringRequests = Pick<BrowserNodeRequests, "usedPeer" | "close">;

const DRAIN_TIMEOUT_MS = 60_000;

/** A replacement realm waits for every original peer transport to drain. */
export class BrowserNodeRetirement {
  private closing: Promise<boolean> = Promise.resolve(true);

  retire(
    requests: RetiringRequests | null,
    worker: Pick<Worker, "terminate"> | null,
  ): void {
    const usedPeer = requests?.usedPeer;
    const drain = requests?.close();
    if (!drain || !usedPeer) {
      worker?.terminate();
      return;
    }
    const bounded = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS);
      drain.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
    this.closing = Promise.all([this.closing, bounded]).then(
      ([previous, current]) => previous && current,
      () => false,
    );
    void bounded.then(() => worker?.terminate());
  }

  async ready(): Promise<void> {
    if (!(await this.closing))
      throw new Error("The original peer transport did not confirm closure.");
  }
}
