import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";

const FILLER = new Set(
  "ok okay k kay yeah yea yep yup yes yah uh uhh um umm uhm erm er hm hmm hmmm mm mmm mhm huh ah oh ooh right alright sure cool nice great good fine thanks thank you got it i see so and well hey hi hello no nope wait".split(" "),
);
const AFFIRM = new Set("yes yeah yep yup sure okay ok alright no nope".split(" "));

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
}
const meaningful = (text: string) => words(text).filter((w) => !FILLER.has(w)).length;

/**
 * Keeps backchannel ("okay", "mm", "thanks") from becoming a turn.
 *
 * Gotcha: the voice mixin aborts the turn in progress on speech-start and on every
 * utterance, before `afterTranscribe` runs. Filtering there is too late, so this
 * wraps the session instead and holds barge-in until real words show up.
 *
 * `expectsAnswer` lets a bare "yes" or "no" through when the AI just asked something.
 */
export class FillerFilter implements Transcriber {
  private inner: Transcriber;
  private expectsAnswer: () => boolean;

  constructor(inner: Transcriber, expectsAnswer: () => boolean) {
    this.inner = inner;
    this.expectsAnswer = expectsAnswer;
  }

  createSession(opts: TranscriberSessionOptions = {}): TranscriberSession {
    let barged = false;
    const bargeIn = () => {
      if (barged) return;
      barged = true;
      opts.onSpeechStart?.();
    };
    return this.inner.createSession({
      ...opts,
      onSpeechStart: () => {},
      onInterim: (text) => {
        if (meaningful(text) >= 2) bargeIn();
        opts.onInterim?.(text);
      },
      onUtterance: (text) => {
        const w = words(text);
        const keep = meaningful(text) >= 1 || (w.length <= 3 && w.some((x) => AFFIRM.has(x)) && this.expectsAnswer());
        if (keep) {
          bargeIn();
          opts.onUtterance?.(text);
        } else {
          opts.onInterim?.("");
        }
        barged = false;
      },
    });
  }
}
