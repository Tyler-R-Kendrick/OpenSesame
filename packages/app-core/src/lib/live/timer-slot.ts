/** One timeout at a time: setting it again replaces the last, clearing it stops it. */
export class TimerSlot {
  #timer: ReturnType<typeof setTimeout> | null = null;

  set(run: () => void, ms: number): void {
    this.clear();
    this.#timer = setTimeout(run, ms);
  }

  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
