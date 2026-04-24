import { useEffect, useMemo, useRef } from "react";
import type { SimulationManifest, Phase, Snapshot } from "../types/manifest";
import { PHASE_COLORS, PHASE_LABEL } from "../utils/phase";
import { getSigma70PresenceArray } from "../utils/sigma";

interface TimelineProps {
  manifest: SimulationManifest;
  frame: number;
  playing: boolean;
  onFrame: (frame: number) => void;
  onTogglePlay: () => void;
  fps: number;
  onFpsChange: (fps: number) => void;
}

/* ------------------------------------------------------------------ */
/* σ⁷⁰ state classification                                           */
/* ------------------------------------------------------------------ */

type SigmaState = "bound" | "releasing" | "released";

const SIGMA_COLORS: Record<SigmaState, string> = {
  bound:     "#ec4899", // fully on holoenzyme — pink, matches 3D legend
  releasing: "#f0abfc", // partial — lighter pink
  released:  "#374151", // gone — dim grey
};

const SIGMA_LABEL: Record<SigmaState, string> = {
  bound:     "bound",
  releasing: "releasing",
  released:  "released",
};

function sigmaStateFromPresence(p: number): SigmaState {
  if (p >= 0.9) return "bound";
  if (p <= 0.1) return "released";
  return "releasing";
}

/* ------------------------------------------------------------------ */
/* Band contiguity helper                                             */
/* ------------------------------------------------------------------ */

function contiguousBands<T extends string>(
  snapshots: Snapshot[],
  classify: (s: Snapshot) => T,
): Array<{ start: number; end: number; kind: T }> {
  const out: Array<{ start: number; end: number; kind: T }> = [];
  if (snapshots.length === 0) return out;
  let runStart = 0;
  let runKind = classify(snapshots[0]);
  for (let i = 1; i < snapshots.length; i++) {
    const k = classify(snapshots[i]);
    if (k !== runKind) {
      out.push({ start: runStart, end: i - 1, kind: runKind });
      runStart = i;
      runKind = k;
    }
  }
  out.push({ start: runStart, end: snapshots.length - 1, kind: runKind });
  return out;
}

/* ------------------------------------------------------------------ */
/* Timeline                                                           */
/* ------------------------------------------------------------------ */

/**
 * Two-lane timeline:
 *   • σ⁷⁰ lane   — bound / releasing / released  (derived from presence fn)
 *   • RNAP lane  — simulation phase (initiation → open complex → elongation
 *                  → paused / backtracked → terminated), with milestone
 *                  event markers (promoter escape, termination, GreB,
 *                  abortive, arrest).
 *
 * The two lanes share a playhead and a scrub slider so the user can step
 * through frames and see both processes in sync.
 */
export function Timeline({
  manifest,
  frame,
  playing,
  onFrame,
  onTogglePlay,
  fps,
  onFpsChange,
}: TimelineProps) {
  const totalFrames = manifest.snapshots.length;
  const currentSnapshot = manifest.snapshots[frame];

  // σ⁷⁰ presence is a monotonic function of simulation time computed once
  // per manifest load. We index it by snapshot frame below so that neither
  // backtracks nor GreB cleavage can resurrect σ⁷⁰ after promoter escape.
  const sigmaPresence = useMemo(
    () => getSigma70PresenceArray(manifest),
    [manifest],
  );
  const currentSigma = sigmaStateFromPresence(sigmaPresence[frame] ?? 0);

  const rnapBands = useMemo(
    () => contiguousBands<Phase>(manifest.snapshots, (s) => s.phase),
    [manifest],
  );

  const sigmaBands = useMemo(
    () =>
      contiguousBands<SigmaState>(manifest.snapshots, (s) =>
        sigmaStateFromPresence(sigmaPresence[s.frame] ?? 0),
      ),
    [manifest, sigmaPresence],
  );

  // Milestone event markers only — per-frame pauses are already visible as
  // phase colour changes, so including them would drown the track.
  const MILESTONE_PATTERNS = useMemo(
    () => [/promoter escape/i, /termination/i, /greb/i, /abortive/i, /arrest/i],
    [],
  );
  const eventMarkers = useMemo(() => {
    return manifest.snapshots
      .filter((s) =>
        s.events.some((e) => MILESTONE_PATTERNS.some((p) => p.test(e))),
      )
      .map((s) => ({ frame: s.frame, events: s.events }));
  }, [manifest, MILESTONE_PATTERNS]);

  // Playback loop. rAF + a time-based gate so we hit the target fps without
  // spinning the main thread needlessly.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    const step = (t: number) => {
      const interval = 1000 / fps;
      if (t - lastTickRef.current >= interval) {
        lastTickRef.current = t;
        const next = frame + 1;
        if (next >= totalFrames) {
          onTogglePlay();
          return;
        }
        onFrame(next);
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, fps, frame, totalFrames, onFrame, onTogglePlay]);

  return (
    <div className="timeline">
      <div className="timeline-header">
        <button
          type="button"
          className="play-btn"
          onClick={onTogglePlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>

        <div className="state-chips">
          <span
            className="phase-chip"
            style={{ background: SIGMA_COLORS[currentSigma] }}
            title="σ⁷⁰ state"
          >
            σ⁷⁰ {SIGMA_LABEL[currentSigma]}
          </span>
          <span
            className="phase-chip"
            style={{ background: PHASE_COLORS[currentSnapshot.phase] }}
            title="RNAP state"
          >
            RNAP {PHASE_LABEL[currentSnapshot.phase]}
          </span>
        </div>

        <div className="frame-readout">
          frame {frame + 1} / {totalFrames}
          {"  ·  t = "}
          {currentSnapshot.time_s.toFixed(2)} s
          {"  ·  +"}
          {currentSnapshot.position}
        </div>

        <label className="fps-control">
          speed
          <input
            type="range"
            min={1}
            max={60}
            step={1}
            value={fps}
            onChange={(e) => onFpsChange(Number(e.target.value))}
          />
          <span>{fps} fps</span>
        </label>
      </div>

      <div className="lane-group">
        <div className="lane-label">σ⁷⁰</div>
        <div className="timeline-bands lane-sigma">
          {sigmaBands.map((b) => {
            const left = (b.start / totalFrames) * 100;
            const width = ((b.end - b.start + 1) / totalFrames) * 100;
            return (
              <div
                key={`sig-${b.start}`}
                className="phase-band"
                title={`σ⁷⁰ ${SIGMA_LABEL[b.kind]}: frames ${b.start}–${b.end}`}
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background: SIGMA_COLORS[b.kind],
                }}
              />
            );
          })}
          <div
            className="playhead"
            style={{ left: `${(frame / Math.max(totalFrames - 1, 1)) * 100}%` }}
          />
        </div>
      </div>

      <div className="lane-group">
        <div className="lane-label">RNAP</div>
        <div className="timeline-bands lane-rnap">
          {rnapBands.map((b) => {
            const left = (b.start / totalFrames) * 100;
            const width = ((b.end - b.start + 1) / totalFrames) * 100;
            return (
              <div
                key={`rnap-${b.start}`}
                className="phase-band"
                title={`${PHASE_LABEL[b.kind]}: frames ${b.start}–${b.end}`}
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background: PHASE_COLORS[b.kind],
                }}
              />
            );
          })}
          {eventMarkers.map((m) => (
            <div
              key={`ev-${m.frame}`}
              className="event-marker"
              title={m.events.join("\n")}
              style={{ left: `${(m.frame / totalFrames) * 100}%` }}
            />
          ))}
          <div
            className="playhead"
            style={{ left: `${(frame / Math.max(totalFrames - 1, 1)) * 100}%` }}
          />
        </div>
      </div>

      {/* Wrap the scrubber in the same two-column grid as the lanes so its
          left edge aligns with the start of the timeline data rather than
          the lane-label gutter. */}
      <div className="lane-group">
        <div className="lane-label" aria-hidden="true" />
        <input
          type="range"
          className="timeline-slider"
          min={0}
          max={totalFrames - 1}
          step={1}
          value={frame}
          onChange={(e) => onFrame(Number(e.target.value))}
          aria-label="Scrub simulation frame"
        />
      </div>
    </div>
  );
}
