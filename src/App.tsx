import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useManifest } from "./hooks/useManifest";
import { useTheme } from "./hooks/useTheme";
import { Timeline } from "./components/Timeline";
import { SequencePanel } from "./components/SequencePanel";
import { InfoPanel } from "./components/InfoPanel";
import { Viewer3D } from "./components/Viewer3D";
import { LoadManifestDialog } from "./components/LoadManifestDialog";
import {
  RenderOptionsButton,
  DEFAULT_RENDER_OPTIONS,
  computeRenderLabel,
  type RenderOptions,
} from "./components/RenderOptionsButton";
import type { RenderMode } from "./render/types";
import type { SimulationManifest } from "./types/manifest";

/** Bounds on the info panel width (px). The lower bound keeps the tab bar
 *  readable; the upper bound is applied *dynamically* at drag time so the
 *  panel can grow up to `containerWidth - VIEWER_COLLAPSE_THRESHOLD_PX`,
 *  letting the 3D viewer shrink smoothly all the way down to the collapse
 *  threshold. */
const INFO_PANEL_MIN_PX = 220;
const INFO_PANEL_DEFAULT_PX = 320;
/** Minimum viewer width before the viewer is forced into collapsed mode.
 *  Below this, dragging snaps the viewer to 0 and the info panel takes
 *  the full width (minus the restore handle). */
const VIEWER_COLLAPSE_THRESHOLD_PX = 120;
/** Minimum info-panel width before it collapses to the thin restore tab.
 *  Symmetrical to VIEWER_COLLAPSE_THRESHOLD_PX. */
const INFO_PANEL_COLLAPSE_THRESHOLD_PX = 120;
/** Width of the thin restore tab rendered on the LHS when the viewer is
 *  collapsed. Kept narrow enough to be clearly a handle, wide enough for
 *  a 24px icon + padding. */
const RESTORE_TAB_PX = 18;
/** Width of the thin restore tab on the RHS when the info panel is collapsed. */
const INFO_RESTORE_TAB_PX = 18;

export default function App() {
  const [manifestState, manifestCtrl] = useManifest();
  const { theme, toggle: toggleTheme } = useTheme();
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(24);
  const [renderOptions, setRenderOptions] = useState<RenderOptions>(
    DEFAULT_RENDER_OPTIONS,
  );
  const [infoWidth, setInfoWidth] = useState(INFO_PANEL_DEFAULT_PX);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [infoPanelCollapsed, setInfoPanelCollapsed] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);

  // Measured width of the .app-main grid container.  Used to clamp the
  // resize drag so the user can shrink the viewer arbitrarily close to
  // the collapse threshold regardless of window size — the previous
  // fixed upper bound capped the info panel at ~50% of the screen.
  const mainRef = useRef<HTMLElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  useLayoutEffect(() => {
    if (!mainRef.current) return;
    const el = mainRef.current;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Until the per-component renderers ship, Viewer3D only cares about the
  // derived overall mode. "atomic" ⇢ show the PDB scaffold; anything else
  // (including "mixed") stays on the procedural schematic view.
  const renderLabel = computeRenderLabel(renderOptions);
  const mode: RenderMode = renderLabel === "atomic" ? "atomic" : "schematic";

  // Key for Viewer3D so the whole component tree is torn down & rebuilt
  // on a manifest swap.  Without this the WebGL canvas keeps its primed
  // framing/user orbit from the previous run, which is confusing when
  // the user has just loaded a brand-new simulation.
  const [viewerKey, setViewerKey] = useState(0);

  /** Handle a successful load from the dialog: swap the manifest, reset
   *  playback/UI to their starting state, and bump the viewer key so
   *  the 3D view re-primes at the new sequence's default framing. */
  const handleManifestLoaded = (manifest: SimulationManifest) => {
    manifestCtrl.setManifest(manifest);
    setFrame(0);
    setPlaying(false);
    setRenderOptions(DEFAULT_RENDER_OPTIONS);
    setViewerCollapsed(false);
    setInfoPanelCollapsed(false);
    setInfoWidth(INFO_PANEL_DEFAULT_PX);
    setViewerKey((k) => k + 1);
  };

  // Draggable vertical divider between the 3D viewer and the info panel.
  //
  // Implementation note (re. the previous "drag crashes the app" bug):
  // the old version added pointermove / pointerup listeners to `document`
  // on pointer-down and computed against a closure-captured
  // `containerWidth`.  When `containerWidth` was still 0 (the layout
  // observer hadn't ticked yet) maxWidth came out as INFO_PANEL_MIN_PX
  // and the threshold check `proposed >= -66` matched on the very first
  // pointermove, snapping the viewer to collapsed and unmounting
  // <Viewer3D/> mid-drag — at which point the still-firing pointer
  // events on the now-detached resizer threw inside React and blanked
  // the screen.  This rewrite:
  //   • uses setPointerCapture on the resizer itself instead of document
  //     listeners (cleaner unwinding when the target element re-renders
  //     or unmounts);
  //   • re-reads containerWidth at *event time*, not at drag-start time,
  //     so a late layout measurement is honoured;
  //   • bails the drag entirely until a real container measurement is
  //     available; and
  //   • finite-checks every computed width before pushing it into state.
  const draggingRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const measuredContainerWidth = (): number => {
    // Prefer the live DOM read so a drag that starts before the
    // ResizeObserver has fired still has a sane width to work against.
    const live = mainRef.current?.clientWidth ?? 0;
    return live > 0 ? live : containerWidth;
  };

  // Shared drag-end cleanup.  Always safe to call even if the drag was
  // not in progress.  Passing the PointerEvent releases capture; omitting
  // it still clears the body cursor/select — use the no-event path when
  // the element may have already been re-rendered or its column made 0-width
  // (Safari throws if releasePointerCapture is called on a zero-size element
  // in a partially-detached tree, so we always guard with try/catch).
  const endDragCleanly = (e?: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    dragStartRef.current = null;
    if (e) {
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch {
        /* pointer may already be released or element not capture-eligible */
      }
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const onResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const cw = measuredContainerWidth();
    // Without a known container width we can't compute clamps safely —
    // skip the drag rather than risk a state update with NaN / Infinity.
    if (!Number.isFinite(cw) || cw <= 0) return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // setPointerCapture can throw (e.g. when the pointer is already
      // released or the element type isn't capture-eligible).  Safe to
      // ignore — the move/up handlers below also run without capture.
    }
    draggingRef.current = true;
    dragStartRef.current = {
      startX: e.clientX,
      startWidth: viewerCollapsed
        ? Math.max(INFO_PANEL_MIN_PX, cw - 6)
        : infoPanelCollapsed
          ? INFO_PANEL_MIN_PX
          : infoWidth,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onResizerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const start = dragStartRef.current;
    if (!start) return;
    const cw = measuredContainerWidth();
    if (!Number.isFinite(cw) || cw <= 0) return;

    const delta = start.startX - e.clientX;
    const maxWidth = Math.max(
      INFO_PANEL_MIN_PX,
      cw - 6 - VIEWER_COLLAPSE_THRESHOLD_PX,
    );
    const proposed = start.startWidth + delta;
    if (!Number.isFinite(proposed)) return;

    // Dragging left past the threshold → viewer too narrow → snap to
    // viewer-collapsed.  We release pointer capture HERE (before the
    // state update) so Safari never receives pointer events against
    // the element after its grid column has been set to 0 width.
    if (proposed >= cw - 6 - VIEWER_COLLAPSE_THRESHOLD_PX / 2) {
      endDragCleanly(e);
      setViewerCollapsed(true);
      return;
    }

    // Dragging right past the threshold → info panel too narrow → snap
    // to info-panel-collapsed.  Same pointer-capture release strategy.
    if (proposed < INFO_PANEL_COLLAPSE_THRESHOLD_PX / 2) {
      endDragCleanly(e);
      setInfoPanelCollapsed(true);
      return;
    }

    const clamped = Math.max(INFO_PANEL_MIN_PX, Math.min(maxWidth, proposed));
    if (!Number.isFinite(clamped)) return;
    setViewerCollapsed(false);
    setInfoPanelCollapsed(false);
    setInfoWidth(clamped);
  };

  const endResizerDrag = (e?: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    endDragCleanly(e);
  };

  // Restore-tab click: bring the viewer back to an equal split (or at
  // least the default info width, whichever gives the viewer room).
  const expandViewer = () => {
    setViewerCollapsed(false);
    setInfoWidth((w) =>
      w < INFO_PANEL_DEFAULT_PX ? INFO_PANEL_DEFAULT_PX : w,
    );
  };

  // Restore-tab click on the RHS: bring the info panel back.
  const expandInfoPanel = () => {
    setInfoPanelCollapsed(false);
    setInfoWidth((w) =>
      w < INFO_PANEL_DEFAULT_PX ? INFO_PANEL_DEFAULT_PX : w,
    );
  };

  // Keyboard shortcuts.  Installed unconditionally so hook order stays stable;
  // bails internally when the manifest isn't loaded yet.
  const totalFrames =
    manifestState.status === "ready" ? manifestState.manifest.snapshots.length : 0;
  useEffect(() => {
    if (totalFrames === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Don't steal keys while the user is interacting with a slider/input.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Don't steal keys while the Load Simulation dialog is open — it
      // has its own URL field and our ← → step would fight the cursor.
      if (loadDialogOpen) return;

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
  }, [totalFrames, loadDialogOpen]);

  if (manifestState.status === "loading") {
    return (
      <div className="app-splash">
        <h1>RNASimVisualiser v.0.1</h1>
        <p>Loading simulation manifest…</p>
      </div>
    );
  }
  if (manifestState.status === "error") {
    return (
      <div className="app-splash error">
        <h1>RNASimVisualiser v.0.1</h1>
        <p>
          Could not load <code>/snapshots.json</code>.
        </p>
        <pre>{manifestState.error}</pre>
        <p>
          Run the Python engine first (see <code>README.md</code>) and make sure
          the output is accessible at <code>/snapshots.json</code>, or use the
          button below to load one from a URL or local file.
        </p>
        <button
          type="button"
          className="load-sim-btn"
          onClick={() => setLoadDialogOpen(true)}
        >
          Load Simulation File…
        </button>
        <LoadManifestDialog
          open={loadDialogOpen}
          onClose={() => setLoadDialogOpen(false)}
          onLoaded={handleManifestLoaded}
        />
      </div>
    );
  }

  const manifest = manifestState.manifest;
  // Frame may be stale right after a manifest swap if the new simulation
  // has fewer snapshots than the old one; clamp defensively.
  const safeFrame = Math.min(frame, manifest.snapshots.length - 1);
  const snapshot = manifest.snapshots[safeFrame];

  // Grid template: collapse states shrink the relevant column to a thin
  // restore tab; both-collapsed leaves a tab on each side; normal state
  // uses "1fr 6px <infoWidth>px".
  const gridTemplateColumns = (() => {
    if (viewerCollapsed && infoPanelCollapsed)
      return `${RESTORE_TAB_PX}px 0 ${INFO_RESTORE_TAB_PX}px`;
    if (viewerCollapsed)
      return `${RESTORE_TAB_PX}px 0 1fr`;
    if (infoPanelCollapsed)
      return `1fr 0 ${INFO_RESTORE_TAB_PX}px`;
    return `1fr 6px ${infoWidth}px`;
  })();

  return (
    <div className="app">
      <header className="app-header">
        {/* Versioned product name.  bp / frames / seed used to live in a
            `.header-meta` row to the right of the title; that meta moved
            into the Sim Data tab of the info panel (Run / Sequence / Base
            pairs blocks) so the header reads cleaner. */}
        <h1>RNASimVisualiser v.0.1</h1>
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
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {/* Show the icon of the target mode so the button telegraphs the
              action rather than the current state. */}
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </header>

      <main
        ref={mainRef}
        className={
          "app-main" +
          (viewerCollapsed ? " viewer-collapsed" : "") +
          (infoPanelCollapsed ? " info-collapsed" : "")
        }
        style={{ gridTemplateColumns }}
      >
        {/* viewer-pane is ALWAYS rendered so Viewer3D is never unmounted
            during a collapse.  3Dmol's internal rAF loop throws on Safari
            when the canvas is torn down mid-drag, blanking the whole app.
            The restore tab is an absolute overlay inside the pane; the
            viewer is hidden via CSS (not removed) when collapsed. */}
        <div className="viewer-pane">
          {viewerCollapsed && (
            <button
              type="button"
              className="viewer-restore-tab"
              onClick={expandViewer}
              title="Show the 3D viewer"
              aria-label="Show the 3D viewer"
            >
              <span className="viewer-restore-icon" aria-hidden="true">›</span>
            </button>
          )}
          <div
            className="viewer3d-wrapper"
            aria-hidden={viewerCollapsed ? "true" : undefined}
            style={viewerCollapsed
              ? { visibility: "hidden", pointerEvents: "none" }
              : undefined}
          >
            <Viewer3D
              key={viewerKey}
              manifest={manifest}
              snapshot={snapshot}
              mode={mode}
              theme={theme}
            />
          </div>
        </div>
        <div
          className="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize info panel"
          onPointerDown={onResizerPointerDown}
          onPointerMove={onResizerPointerMove}
          onPointerUp={endResizerDrag}
          onPointerCancel={endResizerDrag}
        />
        {infoPanelCollapsed ? (
          <button
            type="button"
            className="info-restore-tab"
            onClick={expandInfoPanel}
            title="Show the info panel"
            aria-label="Show the info panel"
          >
            <span className="info-restore-icon" aria-hidden="true">‹</span>
          </button>
        ) : (
          <InfoPanel
            manifest={manifest}
            snapshot={snapshot}
            onLoadSimulation={() => setLoadDialogOpen(true)}
          />
        )}
      </main>

      <section className="sequence-pane">
        <SequencePanel manifest={manifest} snapshot={snapshot} />
      </section>

      <footer className="app-footer">
        <Timeline
          manifest={manifest}
          frame={safeFrame}
          playing={playing}
          onFrame={setFrame}
          onTogglePlay={() => setPlaying((p) => !p)}
          fps={fps}
          onFpsChange={setFps}
        />
      </footer>

      <LoadManifestDialog
        open={loadDialogOpen}
        onClose={() => setLoadDialogOpen(false)}
        onLoaded={handleManifestLoaded}
      />
    </div>
  );
}
