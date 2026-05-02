import { useEffect, useMemo, useRef, useState } from "react";
// 3Dmol's type declarations are incomplete — we confine the loose boundary
// to this file and use a shim in src/types/3dmol.d.ts.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3Dmol does not ship full .d.ts files
import * as $3Dmol from "3dmol";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { Theme } from "../hooks/useTheme";
import type {
  Atom,
  GeometryBuilder,
  GeometryFrame,
  RenderMode,
} from "../render/types";
import { createSchematicBuilder } from "../render/schematic";
import { createAtomicBuilder } from "../render/atomic";
import {
  STYLES_BY_MODE,
  PDB_PROTEIN_STYLE,
  PDB_SIGMA_STYLE,
  PDB_HIDDEN_STYLE,
  PDB_NUCLEIC_CHAINS,
  PDB_SIGMA_CHAINS,
  PDB_PROTEIN_CHAINS,
} from "../render/styles";
import {
  getPdbHoverLabel,
  getSchematicHoverLabel,
  type PdbHoverAtom,
} from "../render/pdbLabels";
import type { RenderOptions } from "./RenderOptionsButton";

interface Viewer3DProps {
  manifest: SimulationManifest;
  snapshot: Snapshot;
  mode: RenderMode;
  /** Per-component render picks (schematic / mesh / atomic).  Passed to the
   *  geometry builder so the legacy two-blob RNAP and four-domain σ⁷⁰
   *  representations stay in place when the user hasn't selected "mesh". */
  options: RenderOptions;
  /** Current colour theme.  The WebGL canvas clears to --viewer-bg, which
   *  is defined per-theme in index.css; we read the computed value via
   *  getComputedStyle and call viewer.setBackgroundColor when it changes. */
  theme: Theme;
}

/** Resolve the current value of --viewer-bg off the document root.  Falls
 *  back to black if the var is unset (e.g. during a stylesheet swap).  We
 *  intentionally re-read each time rather than caching — getComputedStyle
 *  is cheap and it lets the viewer follow dynamic palette tweaks too. */
function readViewerBg(): string {
  if (typeof window === "undefined") return "black";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--viewer-bg")
    .trim();
  return v || "black";
}

const PDB_ID = "6ALF";
const PDB_URL = `https://files.rcsb.org/download/${PDB_ID}.pdb`;

function buildersFor(mode: RenderMode): GeometryBuilder {
  return mode === "atomic" ? createAtomicBuilder() : createSchematicBuilder();
}

/**
 * Convert Atom[] into 3Dmol's minimal atom-object shape. We bypass the PDB
 * text parser to avoid round-tripping strings each frame.
 */
/** Chains drawn as abstract "mesh blobs" rather than nucleic-acid backbone.
 *  Marked hetflag=true so 3Dmol doesn't try to apply polymer-aware styling
 *  (cartoon ribbons, peptide bonds, etc.) to what are really sphere centres
 *  in a procedural cartoon.  Includes:
 *    P    — legacy two-blob RNAP placeholder
 *    W    — W433 indole ring
 *    S    — σ⁷⁰ legacy four-domain blob
 *    M    — σ⁷⁰ four-region mesh (rigid-body, with on-canvas labels)
 *    Y/Z  — RNAP α subunits I and II (mesh mode)
 *    Q/K  — RNAP β / β′ subunits (mesh mode)
 *    O    — RNAP ω subunit (mesh mode)
 */
const HET_CHAINS = new Set(["P", "W", "S", "M", "Y", "Z", "Q", "K", "O"]);

function atomsForThreeDmol(atoms: Atom[]): unknown[] {
  return atoms.map((a) => ({
    elem: a.elem,
    x: a.x,
    y: a.y,
    z: a.z,
    resn: a.resn,
    resi: a.resi,
    chain: a.chain,
    serial: a.serial,
    atom: a.atomName ?? a.elem,
    hetflag: HET_CHAINS.has(a.chain),
    bonds: a.bonds ?? [],
    bondOrder: a.bondOrder ?? [],
    properties: {},
  }));
}

/**
 * Cache a single fetch of the PDB text so re-mounts and mode toggles don't
 * re-download.
 */
let pdbTextPromise: Promise<string> | null = null;
function getPdbText(): Promise<string> {
  if (!pdbTextPromise) {
    pdbTextPromise = fetch(PDB_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`RCSB fetch failed: ${r.status}`);
        return r.text();
      })
      .catch((err) => {
        // Reset so the next atomic-mode click can retry.
        pdbTextPromise = null;
        throw err;
      });
  }
  return pdbTextPromise;
}

/**
 * Initial-view rotation (degrees) applied around the Y-axis after every
 * `zoomTo`. The schematic backbone is built along +Z (see `schematic.ts`),
 * and the default 3Dmol camera looks down -Z, so rotating 90° around Y
 * maps the DNA axis onto screen-X — matching the 5′→3′ left-to-right
 * orientation of the sequence panel.
 */
const INITIAL_Y_ROTATION_DEG = 90;

export function Viewer3D({ manifest, snapshot, mode, options, theme }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ReturnType<typeof $3Dmol.createViewer> | null>(null);
  // Separate model handles so atomic's PDB scaffold survives per-frame rebuilds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdbModelRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicModelRef = useRef<any>(null);
  // Handle of the most recently-added hover tooltip so we can dismiss it
  // before drawing a new one (otherwise labels stack up as the cursor
  // moves across subunits).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hoverLabelRef = useRef<any>(null);
  // Persistent on-canvas labels (RNAP subunit names, σ⁷⁰ region names).
  // Replaced wholesale every frame because positions move with rnapCenter,
  // liftY, assembly, and σ presence — any of which can change between frames.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meshLabelsRef = useRef<any[]>([]);

  const [pdbError, setPdbError] = useState<string | null>(null);
  const [pdbLoading, setPdbLoading] = useState(false);

  // Persistent on-canvas labels (RNAP subunit names, σ⁷⁰ region names) are
  // off by default — they're useful but visually noisy.  Toggle button next
  // to "Reset view" flips this on; hover tooltips remain available either way.
  const [showLabels, setShowLabels] = useState(false);

  // Set of legend-item keys whose corresponding chains are hidden in the
  // 3D view.  Toggled by clicking the legend chips below the canvas.
  const [hiddenItems, setHiddenItems] = useState<Set<string>>(new Set());

  const builder = useMemo(() => buildersFor(mode), [mode]);

  // Legend item definitions — each entry maps a stable key to the chain
  // letter(s) it controls.  dynamicChains: in the per-frame dynamic model.
  // pdbChains: in the PDB scaffold (atomic mode only).
  const legendItems = useMemo(() => {
    const items: Array<{
      key: string;
      label: string;
      color: string;
      dynamicChains: string[];
      pdbChains: string[];
      title?: string;
    }> = [
      { key: "coding",   label: "coding (+)",  color: "#3b82f6", dynamicChains: ["A"],          pdbChains: [] },
      { key: "template", label: "template (-)", color: "#ef4444", dynamicChains: ["B"],          pdbChains: [] },
      { key: "rna",      label: "nascent RNA",  color: "#10b981", dynamicChains: ["R", "T", "H", "U", "X"], pdbChains: [] },
    ];
    if (options.rnap === "mesh") {
      items.push({ key: "alpha",     label: "α₂", color: "#94a3b8", dynamicChains: ["Y", "Z"], pdbChains: ["A", "B"], title: "RNAP α subunits — assembly platform" });
      items.push({ key: "beta",      label: "β",  color: "#64748b", dynamicChains: ["Q"],      pdbChains: ["C"],      title: "RNAP β subunit — upper cleft jaw" });
      items.push({ key: "betaprime", label: "β′", color: "#475569", dynamicChains: ["K"],      pdbChains: ["D"],      title: "RNAP β′ subunit — clamp + active site" });
      items.push({ key: "omega",     label: "ω",  color: "#1e293b", dynamicChains: ["O"],      pdbChains: ["E"],      title: "RNAP ω subunit — β′ chaperone" });
    } else {
      items.push({ key: "rnap", label: "RNAP", color: "#9ca3af", dynamicChains: ["P"], pdbChains: ["A", "B", "C", "D", "E"] });
    }
    items.push({ key: "sigma", label: "σ⁷⁰", color: "#ec4899", dynamicChains: ["S", "M"], pdbChains: ["F"] });
    items.push({ key: "w433",  label: "W433",  color: "#f59e0b", dynamicChains: ["W"],       pdbChains: [] });
    return items;
  }, [options.rnap]);

  const handleLegendToggle = (key: string) => {
    setHiddenItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  /**
   * Re-frame the whole scene to our canonical initial state:
   *   1. setView with an identity quaternion (elements 4-7 of the view
   *      array) zeroes out any user orbit. The position/zoom fields we
   *      pass are degenerate but don't matter — step 2 overwrites them.
   *   2. zoomTo() re-fits the current scene (works whether or not the PDB
   *      model is present, so the schematic-after-atomic case behaves).
   *   3. rotate(90°, y) applies our canonical DNA-horizontal orientation.
   *
   * We deliberately recompute rather than restoring a previously-saved
   * view: after a mode switch the old view may be framed around a model
   * that no longer exists in the scene, producing stale zoom/framing.
   */
  const primeView = (v: ReturnType<typeof $3Dmol.createViewer>) => {
    v.setView([0, 0, 0, 0, 0, 0, 0, 1]);
    v.zoomTo();
    v.rotate(INITIAL_Y_ROTATION_DEG, "y");
  };

  const handleResetView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    primeView(viewer);
    viewer.render();
  };

  // ---------------------------------------------------------------- mount
  useEffect(() => {
    if (!mountRef.current) return;
    const viewer = $3Dmol.createViewer(mountRef.current, {
      backgroundColor: readViewerBg(),
      antialias: true,
    });
    viewerRef.current = viewer;

    // 3Dmol sizes its WebGL canvas to the host element on init, but doesn't
    // listen for container resizes. Without a ResizeObserver the viewer
    // stretches/pixelates when the user drags the info-panel divider.
    const ro = new ResizeObserver(() => {
      viewer.resize?.();
      viewer.render?.();
    });
    ro.observe(mountRef.current);

    return () => {
      ro.disconnect();
      // Defensive teardown: 3Dmol's internal rAF loop can throw on
      // Safari when the canvas is removed while a frame is in flight.
      // Wrapping each step prevents a cleanup error from propagating
      // into React and blanking the page.
      try { viewer.removeAllModels?.(); } catch (_) { /* 3Dmol cleanup */ }
      try { viewer.removeAllLabels?.(); } catch (_) { /* 3Dmol cleanup */ }
      try {
        if (mountRef.current) mountRef.current.innerHTML = "";
      } catch (_) { /* DOM mutation during teardown */ }
      viewerRef.current = null;
      pdbModelRef.current = null;
      dynamicModelRef.current = null;
      hoverLabelRef.current = null;
      meshLabelsRef.current = [];
    };
  }, []);

  // -------------------------------------------------------- theme tracking
  // Re-read --viewer-bg off :root whenever the theme flips and push it
  // straight into the viewer.  setBackgroundColor updates the clear
  // colour in place so we don't have to tear the WebGL context down.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const bg = readViewerBg();
    viewer.setBackgroundColor?.(bg);
    viewer.render?.();
  }, [theme]);

  // ----------------------------------------------------- mode → PDB model
  // Load / unload the static PDB scaffold when the mode changes.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (mode === "atomic") {
      setPdbError(null);
      setPdbLoading(true);
      let cancelled = false;
      getPdbText()
        .then((pdbText) => {
          if (cancelled) return;
          const m = viewer.addModel(pdbText, "pdb");
          pdbModelRef.current = m;

          // Hide nucleic acid chains — our procedural overlay draws them.
          for (const c of PDB_NUCLEIC_CHAINS) {
            viewer.setStyle({ model: m, chain: c }, PDB_HIDDEN_STYLE);
          }
          // Protein subunits — cartoon.
          for (const c of PDB_PROTEIN_CHAINS) {
            viewer.setStyle({ model: m, chain: c }, PDB_PROTEIN_STYLE);
          }
          // σ⁷⁰ — opacity driven per-frame.
          for (const c of PDB_SIGMA_CHAINS) {
            viewer.setStyle({ model: m, chain: c }, PDB_SIGMA_STYLE(1));
          }
          // Hover tooltips on σ⁷⁰ regions and RNAP subunits.  3Dmol's
          // setHoverable takes a hover-in and hover-out callback per
          // selection; we register one selection per model so the
          // callback handles the chain/residue → label lookup itself.
          // (Registering a separate selector per chain would force us to
          // juggle N label refs.)
          viewer.setHoverable(
            { model: m },
            true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (atom: PdbHoverAtom, v: any) => {
              const text = getPdbHoverLabel(atom);
              if (!text) return;
              if (hoverLabelRef.current) {
                v.removeLabel(hoverLabelRef.current);
                hoverLabelRef.current = null;
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const a = atom as any;
              // Read palette vars at show-time so the label follows the
              // live theme even though this callback captured `theme`
              // at effect-registration.
              const rootStyle = getComputedStyle(document.documentElement);
              const bg = rootStyle.getPropertyValue("--bg-panel").trim() || "#111";
              const fg = rootStyle.getPropertyValue("--fg").trim() || "#fff";
              const border = rootStyle.getPropertyValue("--border").trim() || "#555";
              hoverLabelRef.current = v.addLabel(text, {
                position: { x: a.x, y: a.y, z: a.z },
                backgroundColor: bg,
                backgroundOpacity: 0.92,
                fontColor: fg,
                fontSize: 12,
                padding: 4,
                borderThickness: 1,
                borderColor: border,
                inFront: true,
              });
              v.render();
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (_atom: PdbHoverAtom, v: any) => {
              if (hoverLabelRef.current) {
                v.removeLabel(hoverLabelRef.current);
                hoverLabelRef.current = null;
                v.render();
              }
            },
          );
          // Frame the PDB scaffold and re-apply the canonical rotation —
          // without this the zoomTo resets the view and our initial rotation
          // from the per-frame prime would be lost. Reset Y rotation first
          // so the 90° rotate lands at an absolute orientation rather than
          // accumulating on top of whatever the user has orbited to.
          const view = viewer.getView();
          viewer.setView([view[0], view[1], view[2], view[3], 0, 0, 0, 1]);
          viewer.zoomTo({ model: m });
          viewer.rotate(INITIAL_Y_ROTATION_DEG, "y");
          viewer.render();
          setPdbLoading(false);
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setPdbError(
            `Could not load ${PDB_ID} from RCSB: ${err.message}. ` +
              `Atomic mode falls back to procedural.`,
          );
          setPdbLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    // Leaving atomic → drop the PDB model and any lingering hover label.
    if (pdbModelRef.current) {
      if (hoverLabelRef.current) {
        viewer.removeLabel(hoverLabelRef.current);
        hoverLabelRef.current = null;
      }
      viewer.removeModel(pdbModelRef.current);
      pdbModelRef.current = null;
      viewer.render();
    }
    return undefined;
  }, [mode]);

  // ----------------------------------------------------- per-frame redraw
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const frame: GeometryFrame = builder.build(manifest, snapshot, options);

    // Drop the previous dynamic model; keep the PDB model intact.
    if (dynamicModelRef.current) {
      viewer.removeModel(dynamicModelRef.current);
      dynamicModelRef.current = null;
    }
    // Whenever we tear down the dynamic model, any tooltip hanging off one
    // of its atoms is now orphaned (the atom no longer exists).  Drop the
    // ref so the schematic-mode hover handler below starts from a clean
    // slate; otherwise a leftover label from the previous frame can stack
    // up forever as the cursor moves across rebuilt spheres.
    if (hoverLabelRef.current) {
      viewer.removeLabel?.(hoverLabelRef.current);
      hoverLabelRef.current = null;
    }
    const model = viewer.addModel();
    model.addAtoms(atomsForThreeDmol(frame.atoms));
    dynamicModelRef.current = model;

    // Chain styling for the dynamic geometry only (selector includes model id
    // so we don't accidentally restyle the PDB).
    const styles = STYLES_BY_MODE[mode];
    for (const [chain, style] of Object.entries(styles)) {
      viewer.setStyle({ model, chain }, style);
    }

    // Hover tooltips on the *dynamic* model (RNAP body, σ⁷⁰ four-domain
    // cartoon, W433 wedge, DNA / RNA strands).  The atomic-mode block
    // above only registers hovers on the PDB scaffold, which leaves the
    // schematic σ⁷⁰ / RNAP spheres unannotated — registering here means
    // the labels work in both modes.  We re-register every frame because
    // the dynamic model is rebuilt on every frame; setHoverable's
    // registration is per-model and dies with the model, so re-register
    // is required, not just nice-to-have.
    viewer.setHoverable(
      { model },
      true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (atom: PdbHoverAtom, v: any) => {
        const text = getSchematicHoverLabel(atom);
        if (!text) return;
        if (hoverLabelRef.current) {
          v.removeLabel(hoverLabelRef.current);
          hoverLabelRef.current = null;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = atom as any;
        // Read palette vars at show-time so the tooltip follows the live
        // theme even though the closure was captured at register-time.
        const rootStyle = getComputedStyle(document.documentElement);
        const bg = rootStyle.getPropertyValue("--bg-panel").trim() || "#111";
        const fg = rootStyle.getPropertyValue("--fg").trim() || "#fff";
        const border = rootStyle.getPropertyValue("--border").trim() || "#555";
        hoverLabelRef.current = v.addLabel(text, {
          position: { x: a.x, y: a.y, z: a.z },
          backgroundColor: bg,
          backgroundOpacity: 0.92,
          fontColor: fg,
          fontSize: 12,
          padding: 4,
          borderThickness: 1,
          borderColor: border,
          inFront: true,
        });
        v.render();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_atom: PdbHoverAtom, v: any) => {
        if (hoverLabelRef.current) {
          v.removeLabel(hoverLabelRef.current);
          hoverLabelRef.current = null;
          v.render();
        }
      },
    );

    // σ⁷⁰ opacity on the PDB cartoon follows the presence hint,
    // unless the σ⁷⁰ legend item has been hidden by the user.
    if (mode === "atomic" && pdbModelRef.current) {
      const sigmaHidden = hiddenItems.has("sigma");
      for (const c of PDB_SIGMA_CHAINS) {
        viewer.setStyle(
          { model: pdbModelRef.current, chain: c },
          sigmaHidden ? PDB_HIDDEN_STYLE : PDB_SIGMA_STYLE(frame.hints.sigma70Presence),
        );
      }
    }

    // Apply legend-item visibility toggles — override the styles set above
    // by setting hidden chains to an empty style.  Applied last so they win
    // over any per-chain style already set this frame.
    for (const item of legendItems) {
      if (hiddenItems.has(item.key)) {
        for (const chain of item.dynamicChains) {
          viewer.setStyle({ model, chain }, PDB_HIDDEN_STYLE);
        }
        // Also hide the corresponding PDB-model chains in atomic mode.
        if (mode === "atomic" && pdbModelRef.current && item.pdbChains.length > 0) {
          for (const chain of item.pdbChains) {
            viewer.setStyle({ model: pdbModelRef.current, chain }, PDB_HIDDEN_STYLE);
          }
        }
      }
    }

    // ----------------------------------------------------------
    // Persistent on-canvas labels (RNAP subunit names, σ⁷⁰ region
    // names).  Tear down the previous frame's labels and rebuild
    // from frame.labels — positions can move every frame (lift,
    // assembly, σ release), so a diff would be more code than
    // value at this scale (≤10 labels).
    //
    // Schematic mode only: in atomic mode the PDB cartoon plus
    // hover labels carry the same information without on-canvas
    // text clutter.
    // ----------------------------------------------------------
    for (const h of meshLabelsRef.current) {
      try { viewer.removeLabel?.(h); } catch (_) { /* 3Dmol cleanup */ }
    }
    meshLabelsRef.current = [];

    // Render labels only when the user has the canvas-labels toggle on
    // (default off — see `showLabels` state above).  Hover tooltips work
    // independently of this gate, so users can still discover the labels
    // by hovering even when on-canvas text is hidden.
    if (showLabels && mode === "schematic" && frame.labels && frame.labels.length > 0) {
      // Re-read palette vars per-frame so labels follow the live theme
      // and the WebGL clear colour without a viewer rebuild.
      const rootStyle = getComputedStyle(document.documentElement);
      const bg = rootStyle.getPropertyValue("--bg-panel").trim() || "#111";
      const fg = rootStyle.getPropertyValue("--fg").trim() || "#fff";
      const border = rootStyle.getPropertyValue("--border").trim() || "#555";

      for (const lbl of frame.labels) {
        // opacity defaults to 1 when omitted; multiplied through to
        // both the background and the font so σ region labels fade
        // alongside the σ spheres they annotate.
        const op = typeof lbl.opacity === "number" ? lbl.opacity : 1;
        if (op < 0.05) continue; // skip labels that would be invisible
        const handle = viewer.addLabel(lbl.text, {
          position: { x: lbl.position[0], y: lbl.position[1], z: lbl.position[2] },
          backgroundColor: bg,
          backgroundOpacity: 0.78 * op,
          fontColor: fg,
          fontOpacity: op,
          fontSize: 11,
          padding: 2,
          borderThickness: 1,
          borderColor: border,
          inFront: true,
          alignment: "bottomCenter",
        });
        meshLabelsRef.current.push(handle);
      }
    }

    // Zoom + rotate only on first render so the user's framing is preserved.
    if (!viewer.__rnasimPrimed) {
      primeView(viewer);
      viewer.__rnasimPrimed = true;
    }
    viewer.render();
  }, [manifest, snapshot, builder, mode, options, showLabels, legendItems, hiddenItems]);

  return (
    <div className="viewer3d">
      <div ref={mountRef} className="viewer3d-canvas" />
      <div className="viewer3d-legend">
        {legendItems.map(item => {
          const hidden = hiddenItems.has(item.key);
          return (
            <button
              key={item.key}
              type="button"
              className={"viewer3d-legend-item" + (hidden ? " hidden" : "")}
              onClick={() => handleLegendToggle(item.key)}
              title={item.title
                ? `${item.title} — click to ${hidden ? "show" : "hide"}`
                : `Click to ${hidden ? "show" : "hide"} ${item.label}`}
              aria-pressed={hidden}
            >
              <i style={{ background: hidden ? "var(--fg-muted)" : item.color }} />
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          className="viewer3d-reset"
          onClick={handleResetView}
          title="Reset camera to initial view"
        >
          Reset view
        </button>
        <button
          type="button"
          className={"viewer3d-reset" + (showLabels ? " active" : "")}
          onClick={() => setShowLabels((v) => !v)}
          title={
            showLabels
              ? "Hide on-canvas subunit / region labels (hover still works)"
              : "Show on-canvas subunit / region labels (mesh modes only)"
          }
          aria-pressed={showLabels}
        >
          {showLabels ? "Labels: on" : "Labels: off"}
        </button>
      </div>
      {mode === "atomic" && pdbLoading && (
        <div className="viewer3d-status">Loading PDB {PDB_ID} from RCSB…</div>
      )}
      {pdbError && <div className="viewer3d-status error">{pdbError}</div>}
    </div>
  );
}
