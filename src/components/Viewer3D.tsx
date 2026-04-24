import { useEffect, useMemo, useRef, useState } from "react";
// 3Dmol's type declarations are incomplete — we confine the loose boundary
// to this file and use a shim in src/types/3dmol.d.ts.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3Dmol does not ship full .d.ts files
import * as $3Dmol from "3dmol";
import type { SimulationManifest, Snapshot } from "../types/manifest";
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

interface Viewer3DProps {
  manifest: SimulationManifest;
  snapshot: Snapshot;
  mode: RenderMode;
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
    hetflag: a.chain === "P" || a.chain === "W" || a.chain === "S",
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

export function Viewer3D({ manifest, snapshot, mode }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ReturnType<typeof $3Dmol.createViewer> | null>(null);
  // Separate model handles so atomic's PDB scaffold survives per-frame rebuilds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdbModelRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicModelRef = useRef<any>(null);

  const [pdbError, setPdbError] = useState<string | null>(null);
  const [pdbLoading, setPdbLoading] = useState(false);

  const builder = useMemo(() => buildersFor(mode), [mode]);

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
      backgroundColor: "black",
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
      viewer.removeAllModels?.();
      viewer.removeAllLabels?.();
      if (mountRef.current) mountRef.current.innerHTML = "";
      viewerRef.current = null;
      pdbModelRef.current = null;
      dynamicModelRef.current = null;
    };
  }, []);

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

    // Leaving atomic → drop the PDB model.
    if (pdbModelRef.current) {
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

    const frame: GeometryFrame = builder.build(manifest, snapshot);

    // Drop the previous dynamic model; keep the PDB model intact.
    if (dynamicModelRef.current) {
      viewer.removeModel(dynamicModelRef.current);
      dynamicModelRef.current = null;
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

    // σ⁷⁰ opacity on the PDB cartoon follows the presence hint.
    if (mode === "atomic" && pdbModelRef.current) {
      for (const c of PDB_SIGMA_CHAINS) {
        viewer.setStyle(
          { model: pdbModelRef.current, chain: c },
          PDB_SIGMA_STYLE(frame.hints.sigma70Presence),
        );
      }
    }

    // Zoom + rotate only on first render so the user's framing is preserved.
    if (!viewer.__rnasimPrimed) {
      primeView(viewer);
      viewer.__rnasimPrimed = true;
    }
    viewer.render();
  }, [manifest, snapshot, builder, mode]);

  return (
    <div className="viewer3d">
      <div ref={mountRef} className="viewer3d-canvas" />
      <div className="viewer3d-legend">
        <span><i style={{ background: "#3b82f6" }} /> coding (+)</span>
        <span><i style={{ background: "#ef4444" }} /> template (-)</span>
        <span><i style={{ background: "#10b981" }} /> nascent RNA</span>
        <span><i style={{ background: "#9ca3af" }} /> RNAP</span>
        <span><i style={{ background: "#ec4899" }} /> σ⁷⁰</span>
        <span><i style={{ background: "#f59e0b" }} /> W433</span>
        <button
          type="button"
          className="viewer3d-reset"
          onClick={handleResetView}
          title="Reset camera to initial view"
        >
          Reset view
        </button>
      </div>
      {mode === "atomic" && pdbLoading && (
        <div className="viewer3d-status">Loading PDB {PDB_ID} from RCSB…</div>
      )}
      {pdbError && <div className="viewer3d-status error">{pdbError}</div>}
    </div>
  );
}
