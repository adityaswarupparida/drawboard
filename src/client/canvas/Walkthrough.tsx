import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND_LABEL, type Diagram } from "../../shared/diagram";
import type { ClientMessage, Tour } from "../../shared/protocol";
import { KindIcon } from "../icons";

/** Stop 0 is the intro, 1..n are boxes, n + 1 is the wrap-up. */
export function useTour(tour: Tour | null, setTour: (t: Tour | null) => void, send: (m: ClientMessage) => void, diagram: Diagram) {
  const [active, setActive] = useState(false);
  const [stop, setStop] = useState(0);
  // Someone may delete a box mid-tour; skip it rather than point at nothing.
  const steps = useMemo(() => (tour?.steps ?? []).filter((s) => diagram.nodes.some((n) => n.id === s.nodeId)), [tour, diagram.nodes]);
  const last = steps.length + 1;

  useEffect(() => {
    if (stop > last) setStop(last);
  }, [stop, last]);

  const start = useCallback(() => {
    setTour(null);
    setStop(0);
    setActive(true);
    send({ type: "tour" });
  }, [send, setTour]);

  const focus: string | null = !active ? null : stop >= 1 && stop <= steps.length ? steps[stop - 1]!.nodeId : "all";
  const jumpTo = (nodeId: string) => {
    const i = steps.findIndex((s) => s.nodeId === nodeId);
    if (i >= 0) setStop(i + 1);
  };
  return { active, start, close: () => setActive(false), stop, setStop, steps, last, focus, jumpTo, tour };
}

type TourCtl = ReturnType<typeof useTour>;

export function WalkthroughCard({ ctl, diagram, projectId, showToast }: { ctl: TourCtl; diagram: Diagram; projectId: string; showToast: (t: string) => void }) {
  const { tour, stop, setStop, steps, last, close, jumpTo } = ctl;
  const [narrate, setNarrate] = useState(false);
  const narrator = useNarrator(projectId);
  const byId = useMemo(() => new Map(diagram.nodes.map((n) => [n.id, n])), [diagram.nodes]);

  const next = useCallback(() => (stop >= last ? close() : setStop(stop + 1)), [stop, last, close, setStop]);
  const back = useCallback(() => setStop(Math.max(0, stop - 1)), [stop, setStop]);

  const speechFor = (i: number): string => {
    if (!tour) return "";
    if (i === 0) return tour.intro;
    if (i === last) return tour.done ? tour.outro : "";
    const s = steps[i - 1];
    const n = s && byId.get(s.nodeId);
    return s && n && s.what ? `${n.label}. ${s.what} ${s.why}` : "";
  };
  const speech = speechFor(stop);
  const upcoming = speechFor(stop + 1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, close]);

  // Read the stop aloud, then move on by itself, like a guided tour.
  useEffect(() => {
    if (!narrate || !speech) return;
    const run = { cancelled: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    narrator
      .play(speech, run)
      .then((ended) => {
        if (ended && !run.cancelled && stop < last) timer = setTimeout(() => setStop(stop + 1), 900);
      })
      .catch(() => {
        if (run.cancelled) return;
        showToast("Narration isn't available right now.");
        setNarrate(false);
      });
    return () => {
      run.cancelled = true;
      clearTimeout(timer);
      narrator.stop();
    };
  }, [narrate, speech, stop, last, narrator, setStop, showToast]);

  useEffect(() => {
    if (narrate && upcoming) narrator.load(upcoming).catch(() => {});
  }, [narrate, upcoming, narrator]);

  const waiting = (text: string) => (
    <div className="think">
      <span className="dots"><i /><i /><i /></span>
      {text}
    </div>
  );

  let body: React.ReactNode;
  if (stop === 0) {
    body = (
      <>
        <h3>How this system works</h3>
        {tour?.intro ? <p>{tour.intro}</p> : waiting("Reading the diagram")}
      </>
    );
  } else if (stop === last) {
    body = (
      <>
        <h3>That's the whole path</h3>
        {tour?.done ? <p>{tour.outro}</p> : waiting("Wrapping up")}
        <button type="button" className="linkish" onClick={() => setStop(0)}>Start over</button>
      </>
    );
  } else {
    const s = steps[stop - 1]!;
    const n = byId.get(s.nodeId);
    const from = diagram.edges.filter((e) => e.target === s.nodeId && byId.has(e.source));
    const to = diagram.edges.filter((e) => e.source === s.nodeId && byId.has(e.target));
    body = n ? (
      <>
        <div className="tour-title">
          <KindIcon kind={n.kind} />
          <div>
            <span className="tour-kind">{KIND_LABEL[n.kind]}</span>
            <h3>{n.label}</h3>
          </div>
        </div>
        {s.what ? (
          <>
            <p><b>What it is.</b> {s.what}</p>
            <p><b>Why it's here.</b> {s.why}</p>
          </>
        ) : (
          waiting("Writing this stop")
        )}
        {(from.length > 0 || to.length > 0) && (
          <div className="tour-links">
            {from.length > 0 && (
              <span>
                From{" "}
                {from.map((e) => (
                  <button key={e.id} type="button" className="chip" onClick={() => jumpTo(e.source)}>{byId.get(e.source)!.label}</button>
                ))}
              </span>
            )}
            {to.length > 0 && (
              <span>
                To{" "}
                {to.map((e) => (
                  <button key={e.id} type="button" className="chip" onClick={() => jumpTo(e.target)}>
                    {byId.get(e.target)!.label}{e.label ? ` · ${e.label}` : ""}
                  </button>
                ))}
              </span>
            )}
          </div>
        )}
      </>
    ) : null;
  }

  return (
    <div className="tour" role="dialog" aria-label="Walkthrough" aria-live="polite">
      <div className="tour-head">
        <span>Walkthrough{stop > 0 && stop < last ? ` · ${stop} of ${steps.length}` : ""}</span>
        <button type="button" className="tour-x" onClick={close} aria-label="End walkthrough">×</button>
      </div>
      {body}
      <div className="tour-bar" aria-hidden="true">
        {Array.from({ length: last + 1 }, (_, i) => (
          <i key={i} className={i < stop ? "done" : i === stop ? "on" : ""} />
        ))}
      </div>
      <div className="tour-foot">
        <button type="button" className={`tbtn${narrate ? " on" : ""}`} aria-pressed={narrate} onClick={() => setNarrate((v) => !v)} title="Read each stop aloud and move on automatically">
          {narrate ? "Stop narration" : "Read aloud"}
        </button>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={back} disabled={stop === 0}>Back</button>
        <button type="button" className="btn small primary" onClick={next}>{stop === 0 ? "Start" : stop === last ? "Done" : "Next"}</button>
      </div>
    </div>
  );
}

/** Fetches narration audio once per text and plays one clip at a time. */
function useNarrator(projectId: string) {
  const clips = useRef(new Map<string, Promise<string>>());
  const current = useRef<HTMLAudioElement | null>(null);

  const narrator = useMemo(() => {
    const load = (text: string) => {
      let p = clips.current.get(text);
      if (!p) {
        p = fetch(`/api/projects/${projectId}/speak`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }).then(async (r) => {
          if (!r.ok) throw new Error("speak failed");
          return URL.createObjectURL(await r.blob());
        });
        clips.current.set(text, p);
        p.catch(() => clips.current.delete(text));
      }
      return p;
    };
    const stop = () => {
      current.current?.pause();
      current.current = null;
    };
    /** Resolves true when the clip finishes, false if it couldn't play. Never resolves once stopped. */
    const play = async (text: string, run: { cancelled: boolean }) => {
      const url = await load(text);
      if (run.cancelled) return false;
      stop();
      const a = new Audio(url);
      current.current = a;
      return new Promise<boolean>((resolve) => {
        a.onended = () => resolve(true);
        a.onerror = () => resolve(false);
        a.play().catch(() => resolve(false));
      });
    };
    return { load, play, stop };
  }, [projectId]);

  useEffect(
    () => () => {
      narrator.stop();
      for (const p of clips.current.values()) p.then(URL.revokeObjectURL, () => {});
    },
    [narrator],
  );
  return narrator;
}
