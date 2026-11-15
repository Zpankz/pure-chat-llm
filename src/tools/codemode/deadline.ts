/**
 * A script's wall-clock deadline that can pause, so time spent waiting for the user (a review or
 * confirmation dialog opened by a tool the script called) does not count against the script.
 * Pauses nest: the clock runs again when the last paused call is done.
 */
export class ScriptDeadline {
  private remaining: number;
  private startedAt = 0;
  private timer = 0;
  private pauses = 0;
  private done = false;

  /**
   * Starts the clock.
   * @param ms - Time the script may run.
   * @param onExpire - Called once when the time is up.
   */
  constructor(
    ms: number,
    private onExpire: () => void,
  ) {
    this.remaining = ms;
    this.arm();
  }

  /** Arms the timer for the time left. */
  private arm(): void {
    this.startedAt = Date.now();
    this.timer = window.setTimeout(
      () => {
        this.done = true;
        this.onExpire();
      },
      Math.max(0, this.remaining),
    );
  }

  /** Stops the clock until `resume`. */
  pause(): void {
    if (this.done || this.pauses++ > 0) return;
    window.clearTimeout(this.timer);
    this.remaining -= Date.now() - this.startedAt;
  }

  /** Starts the clock again once every `pause` has been matched. */
  resume(): void {
    if (this.pauses === 0) return;
    if (--this.pauses === 0 && !this.done) this.arm();
  }

  /** Stops the clock for good. */
  stop(): void {
    this.done = true;
    window.clearTimeout(this.timer);
  }
}
