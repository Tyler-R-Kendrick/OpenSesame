import type { BrowserNodeRequests } from "./controller-requests.js";

type RetiringRequests = Pick<BrowserNodeRequests, "usedPeer" | "close">;

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
    this.closing = Promise.all([this.closing, drain]).then(
      ([previous, current]) => previous && current,
      () => false,
    );
    void drain.then(
      () => worker?.terminate(),
      () => worker?.terminate(),
    );
  }

  async ready(): Promise<void> {
    if (!(await this.closing))
      throw new Error("The original peer transport did not confirm closure.");
  }
}
