import { useEffect, useRef, useState } from "react";
import { useManifest } from "./hooks/useManifest";
import { Timeline } from "./components/Timeline";
import { SequencePanel } from "./components/SequencePanel";
import { InfoPanel } from "./components/InfoPanel";
import { Viewer3D } from "./components/Viewer3D";
import {
  RenderOptionsButton,
  DEFAULT_RENDER_OPTIONS,
  computeRenderLabel,
  type RenderOptions,
} from "./components/RenderOptionsButton";
import type { RenderMode } from "./render/types";

/** Bounds on the info panel width (px). The lower bound keeps the tab bar
 *  readable; the upper bound keeps the 3D viewer usable on modest screens. */
const INFO_PANEL_MIN_PX = 220;
const INFO_PANEL_MAX_PX = 720;
const INFO_PANEL_DEFAULT_PX = 320;

export default function App() {
  const state = useManifest();
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(24);
  const [renderOptions, setRenderOptions] = useState<RenderOptions>(
    DEFAULT_RENDER_OPTIONS,
  );
  const [infoWidth, setInfoWidth] = useState(INFO_PANEL_DEFAULT_PX);

  // Until the per-component renderers ship, Viewer3D only cares about the
  // derived overall mode. "atomic" ⇢ show the PDB scaffold; anything else
  // (including "mixed") stays on the procedural schematic view.
  const renderLabel = computeRenderLabel(renderOptions);
  const mode: RenderMode = renderLabel === "atomic" ? "atomic" : "schematic";

  // Draggable vertical divider between the 3D viewer and the info panel.
  // Listeners are attached to document on pointer-down and removed on
  // pointer-up so the drag keeps tracking even when the cursor leaves the
  // handle (including going into the 3D viewer canvas, which would otherwise
  // swallow mousemove).
  const draggingRef = useRef(false);
  const onResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startWidth = infoWidth;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      // Dragging left (clientX decreases) grows the info panel.
      const delta = startX - ev.clientX;
      const next = Math.max(
        INFO_PANEL_MIN_PX,
        Math.min(INFO_PANEL_MAX_PX, startWidth + delta),
      );
      setInfoWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // Keyboard shortcuts.  Installed unconditionally so hook order stays stable;
  // bails internally when the manifest isn't loaded yet.
  const totalFrames =
    state.status === "ready" ? state.manifest.snapshots.length : 0;
  useEffect(() => {
    if (totalFrames === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Don't steal keys while the user is interacting with a slider/input.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const step = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          setFrame((f) => Math.max(0, f - step));
          break;
        case "ArrowRight":
          e.preventDefault();
          setFrame((f) => Math.min(totalFrames - 1, f + step));
          break;
        case " ":
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        case "Home":
          e.preventDefault();
          setFrame(0);
          break;
        case "End":
          e.preventDefault();
          setFrame(totalFrames - 1);
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [totalFrames]);

  if (state.status === "loading") {
    return (
      <div className="app-splash">
        <h1>rnasim</h1>
        <p>Loading simulation manifest…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="app-splash error">
        <h1>rnasim</h1>
        <p>
          Could not load <code>/snapshots.json</code>.
        </p>
        <pre>{state.error}</pre>
        <p>
          Run the Python engine first (see <code>README.md</code>) and make sure
          the output is accessible at <code>/snapshots.json</code>.
        </p>
      </div>
    );
  }

  const manifest = state.manifest;
  const snapshot = manifest.snapshots[frame];

  return (
    <div className="app">
      <header className="app-header">
        <h1>rnasim</h1>
        <div className="header-meta">
          <span>{manifest.sequence.sequence_length} bp</span>
          <span>·</span>
          <span>{manifest.metadata.total_frames} frames</span>
          <span>·</span>
          <span>seed {manifest.metadata.random_seed ?? "—"}</span>
        </div>
        <div
          className="keys-hint"
          title="← →  step frame · Shift + ← →  step 10 · Space  play/pause · Home/End  jump"
        >
          ← → step · shift ± 10 · ␣ play
        </div>
        <RenderOptionsButton
          options={renderOptions}
          onChange={setRenderOptions}
        />
      </header>

      <main
        className="app-main"
        style={{ gridTemplateColumns: `1fr 6px ${infoWidth}px` }}
      >
        <div className="viewer-pane">
          <Viewer3D manifest={manifest} snapshot={snapshot} mode={mode} />
        </div>
        <div
          className="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize info panel"
          onPointerDown={onResizerPointerDown}
        />
        <InfoPanel manifest={manifest} snapshot={snapshot} />
      </main>

      <section className="sequence-pane">
        <SequencePanel manifest={manifest} snapshot={snapshot} />
      </section>

      <footer className="app-footer">
        <Timeline
          manifest={manifest}
          frame={frame}
          playing={playing}
          onFrame={setFrame}
          onTogglePlay={() => setPlaying((p) => !p)}
          fps={fps}
          onFpsChange={setFps}
        />
      </footer>
    </div>
  );
}
