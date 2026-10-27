// Spoken replies stay short; the full text is in the chat.
const SPOKEN_LIMIT = 420;

/**
 * Turns a reply that grows while the model streams into text for TTS, so speech can
 * start on the first sentence instead of after the whole turn (and its self-check).
 * `update` takes the full reply so far; `chunks` yields only what's new.
 */
export class SpeechStream {
  private seen = "";
  private queue: string[] = [];
  private last = "";
  private spoken = 0;
  private cutAtNextSpace = false;
  private capped = false;
  private noteSaid = false;
  private ended = false;
  private wake: (() => void) | null = null;

  update(full: string) {
    if (!full.startsWith(this.seen)) return;
    const delta = full.slice(this.seen.length);
    this.seen = full;
    if (delta) this.push(delta);
  }

  /** `final` covers turns that never streamed, such as errors or fallbacks. */
  finish(final: string) {
    if (!this.seen) this.update(final.trim());
    else if (final.startsWith(this.seen)) this.update(final);
    this.ended = true;
    this.notify();
  }

  async *chunks(): AsyncGenerator<string> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private push(delta: string) {
    let out = "";
    for (const ch of delta) {
      if (this.capped) {
        // Only mention the chat if the reply really goes on.
        if (!this.noteSaid && /\S/.test(ch)) {
          out += " The rest is in the chat.";
          this.noteSaid = true;
        }
        continue;
      }
      if (this.cutAtNextSpace) {
        this.cutAtNextSpace = false;
        // A space after the stop means a real sentence end, not "10.5".
        if (/\s/.test(ch)) {
          this.capped = true;
          continue;
        }
      }
      if (ch === "•" || ch === "*") continue;
      if (ch === "\n") {
        // List lines rarely end in a full stop; without one the TTS splitter runs them together.
        if (this.last && !/[.!?:;,\s]/.test(this.last)) out += ". ";
        else if (this.last && this.last !== " ") out += " ";
        this.last = " ";
        continue;
      }
      if (ch === " " && this.last === " ") continue;
      out += ch;
      this.last = ch;
      this.spoken++;
      if (this.spoken > SPOKEN_LIMIT && /[.!?]/.test(ch)) this.cutAtNextSpace = true;
    }
    if (!out) return;
    this.queue.push(out);
    this.notify();
  }

  private notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}
