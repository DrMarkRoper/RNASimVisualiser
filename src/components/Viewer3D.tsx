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
import { createAtomicBuilder, emitAtomicPdbText, type RnaResiRange } from "../render/atomic";
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
  /** Setter for `options` — used by the representation pill button at
   *  the bottom of the viewer (Molecular / Bar / Both).  All other
   *  RenderOptions edits go through the header's RenderOptionsButton
   *  popup; the in-viewer pill is just a quick switch for the
   *  representation field. */
  onOptionsChange: (next: RenderOptions) => void;
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

/**
 * Hover-label resolver for atoms in the ATOMIC model (PDB-parsed).
 * Chain IDs are single-char (A/B/R/T/H/U) so we map them directly
 * to the atomic-mode strand role.  Includes the residue name (base
 * identity) and atom name when the AtomSpec carries them.
 *
 * Distinct from `getSchematicHoverLabel` which handles the dynamic
 * model where chain "A" means coding-band sphere; here chain "A"
 * means coding atomic-mode atom.  Two separate hover registrations
 * (one per model) so the chain-letter ambiguity is resolved by the
 * model the hover fires on.
 */
function atomicChainHoverLabel(spec: PdbHoverAtom): string | null {
  const { chain, resi, resn, atom: atomName } = spec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role: Record<string, string> = {
    A: "Coding (+) strand",
    B: "Template (-) strand",
    R: "Nascent RNA (exit channel)",
    T: "RNA hybrid / σ-trapped coil",
    H: "Terminator hairpin RNA",
    U: "Terminator U-tract RNA",
  };
  const r = chain ? role[chain] : null;
  if (!r) return null;
  const baseLabel = resn ? ` ${resn}` : "";
  const resiLabel = typeof resi === "number" ? ` resi ${resi}` : "";
  const atomLabel = atomName ? ` · atom ${atomName}` : "";
  return `${r}${baseLabel}${resiLabel}${atomLabel}`;
}

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

export function Viewer3D({ manifest, snapshot, mode, options, onOptionsChange, theme }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ReturnType<typeof $3Dmol.createViewer> | null>(null);
  // Separate model handles so atomic's PDB scaffold survives per-frame rebuilds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdbModelRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicModelRef = useRef<any>(null);
  // Atomic-mode strand model.  Loaded via addModel(pdbText, "pdb")
  // when at least one strand has its per-component pick set to
  // "atomic" — this triggers 3Dmol's PDB parser, which applies its
  // standard nucleic-acid bond template (correctly drawing pentagonal
  // sugar rings + hexagonal base rings).  The dynamic model alone
  // (via addAtoms) doesn't get this treatment and the rings render
  // with cross-bonds.  Single-char chain IDs (A/B/R/T/H/U) collide
  // with the schematic's band chains in the dynamic model, but
  // they're namespaced because each model is queried independently
  // via {model: x, chain: y} selectors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atomicModelRef = useRef<any>(null);
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

  // Convenience: read the current representation choice off RenderOptions.
  // The pill button at the bottom of the viewer (Molecular / Bar / Both)
  // sets it via the parent state; we just react to changes here.
  const representation = options.representation;

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
      { key: "coding",   label: "coding (+)",  color: "#3b82f6", dynamicChains: ["A", "A_at"],                                    pdbChains: [] },
      { key: "template", label: "template (-)", color: "#ef4444", dynamicChains: ["B", "B_at"],                                    pdbChains: [] },
      { key: "rna",      label: "nascent RNA",  color: "#10b981", dynamicChains: ["R", "T", "H", "U", "X", "R_at", "T_at", "H_at", "U_at"], pdbChains: [] },
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
      atomicModelRef.current = null;
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
    // Atomic-chain atoms used to be appended to `frame.atoms` here
    // (via `augmentSchematicWithAtomic`) and loaded into the dynamic
    // model alongside the schematic atoms.  That path is now
    // bypassed: atomic chains go through the PDB parser route below
    // (addModel(pdbText, "pdb")) so 3Dmol applies its standard
    // nucleic-acid bond template and rings render correctly.

    // Drop the previous dynamic model; keep the PDB model intact.
    if (dynamicModelRef.current) {
      viewer.removeModel(dynamicModelRef.current);
      dynamicModelRef.current = null;
    }
    // Drop the previous atomic-strand model.  Always rebuilt every
    // frame because residues / bubble / chain assignments shift with
    // simulation state.
    if (atomicModelRef.current) {
      viewer.removeModel(atomicModelRef.current);
      atomicModelRef.current = null;
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

    // Atomic-strand model — loaded via PDB parser so 3Dmol applies
    // its standard nucleic-acid bond template (correctly drawing
    // pentagonal sugar rings + hexagonal base rings).  Skipped when
    // no strand pick is "atomic"; per-strand styling further down
    // reads the same picks to decide which chains to style.
    const { pdbText: atomicPdbText, rnaResiRanges } = emitAtomicPdbText(manifest, snapshot, options);
    if (atomicPdbText) {
      atomicModelRef.current = viewer.addModel(atomicPdbText, "pdb");
    }

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

    // Hover on the atomic model — strand+base+atom labels via
    // getSchematicHoverLabel.  Atomic chain IDs are single-char
    // (A/B/R/T/H/U) which collide with the dynamic model's band
    // chains, but we register the hover scoped to atomicModelRef so
    // the chain-letter lookup unambiguously means "atomic strand".
    // We use a separate translator (atomicChainHoverLabel) that maps
    // the single-char chain to the atomic-mode role string.
    if (atomicModelRef.current) {
      const am = atomicModelRef.current;
      viewer.setHoverable(
        { model: am },
        true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (atom: PdbHoverAtom, v: any) => {
          const text = atomicChainHoverLabel(atom);
          if (!text) return;
          if (hoverLabelRef.current) {
            v.removeLabel(hoverLabelRef.current);
            hoverLabelRef.current = null;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = atom as any;
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
    }

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

    // Per-strand visibility.
    //
    // Each strand's per-component pick (`options.coding/template/rna`)
    // chooses between:
    //   "schematic" → render the band sphere chain unconditionally
    //                 (A, B, R+T+H+U); hide the atomic sibling.
    //   "atomic"    → hide the band sphere chain; render the atomic
    //                 sibling with a style that depends on
    //                 representation:
    //                   • molecular → stick + sphere only
    //                   • cartoon   → cartoon ribbon only
    //                   • both      → cartoon + stick + sphere
    //
    // Chain X (backtracked RNA) has no atomic sibling — it always
    // renders via its band style as long as the rna pick is
    // "schematic"; when rna is "atomic" we currently still show
    // chain X (the user can hide it via the legend chip if needed).
    interface StrandConfig {
      atomicPick: boolean;
      /** Chain IDs in the DYNAMIC model (band spheres). */
      bandChains: string[];
      /** Chain IDs in the ATOMIC model (PDB-parsed atoms).  Single-
       *  char per PDB ATOM record format; collide with band chain
       *  IDs but namespaced by model membership. */
      atomicChains: string[];
      /** Carbon / ribbon hex per atomic chain, indexed parallel to
       *  atomicChains.  Lets the same RNA strand-pick drive different
       *  per-state chain colours (T amber, R green, H violet, U pink). */
      atomicColors: string[];
    }
    const strandConfigs: StrandConfig[] = [
      {
        atomicPick: options.coding === "atomic",
        bandChains: ["A"],
        atomicChains: ["A"],   // chain "A" in atomicModelRef (separate model)
        atomicColors: ["#3b82f6"],
      },
      {
        atomicPick: options.template === "atomic",
        bandChains: ["B"],
        atomicChains: ["B"],
        atomicColors: ["#ef4444"],
      },
      {
        atomicPick: options.rna === "atomic",
        bandChains: ["R", "T", "H", "U"],
        // All RNA sections are now on a single unified PDB chain "R" so the
        // cartoon renderer draws one continuous ribbon.  Per-section colours
        // are applied via per-resi-range setStyle calls in the block below
        // (after the strandConfigs loop) rather than per-chain here.
        atomicChains: [],
        atomicColors: [],
      },
    ];

    // Build the atomic-chain style for the current representation,
    // parameterised on the chain's ribbon colour.  Stick / sphere
    // always use a neutral light-grey carbon (with the CPK ramp for
    // N/O/P) so the bases / sugars read as standard ball-and-stick;
    // chain identity is carried by the cartoon ribbon's colour.
    const ATOMIC_SPHERE_RADIUS = 0.18;
    const ATOMIC_STICK_RADIUS  = 0.22;
    const ATOM_COLORSCHEME = (carbonHex: string) => ({
      prop: "elem" as const,
      map: {
        C: carbonHex, N: "#1e3a8a", O: "#dc2626", P: "#f97316", H: "#cccccc",
      },
    });
    function atomicStyleFor(chainColor: string): Record<string, unknown> {
      const style: Record<string, unknown> = {};
      if (representation === "molecular" || representation === "both") {
        style.stick = { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") };
        style.sphere = { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") };
      }
      if (representation === "cartoon" || representation === "both") {
        style.cartoon = { color: chainColor, style: "rectangle", thickness: 0.4 };
      }
      return style;
    }

    for (const sc of strandConfigs) {
      if (sc.atomicPick) {
        // Atomic — hide band chain in dynamic model; style atomic
        // sibling chain in the atomic PDB model per representation.
        for (const c of sc.bandChains) {
          viewer.setStyle({ model, chain: c }, PDB_HIDDEN_STYLE);
        }
        if (atomicModelRef.current) {
          for (let i = 0; i < sc.atomicChains.length; i++) {
            viewer.setStyle(
              { model: atomicModelRef.current, chain: sc.atomicChains[i] },
              atomicStyleFor(sc.atomicColors[i]),
            );
          }
          // Hide the phantom 3' residue that was appended to each DNA
          // strand so 3Dmol's cartoon doesn't trim the last real base
          // (see emitStrandPdb in render/atomic.ts).  The phantom sits
          // at chainResi = seq.length + 1 on chains A and B.  Overriding
          // with PDB_HIDDEN_STYLE here removes it from all representations
          // (molecular / cartoon / both) while the PDB structure still
          // carries the residue for the cartoon trace.
          const isDnaStrand = sc.atomicChains.some(c => c === "A" || c === "B");
          if (isDnaStrand) {
            const phantomResi = manifest.sequence.coding_strand.length + 1;
            for (const chain of sc.atomicChains) {
              viewer.setStyle(
                { model: atomicModelRef.current, chain, resi: phantomResi },
                PDB_HIDDEN_STYLE,
              );
            }
          }
        }
      }
      // Schematic — keep band visible (already styled in the
      // STYLES_BY_MODE pass above).  No need to hide the atomic
      // model chains defensively because we drop+rebuild
      // atomicModelRef every frame, and we only emit atoms for
      // strands whose pick is "atomic".
    }

    // ---------------------------------------------------------------
    // Per-section RNA colouring for the unified atomic chain "R".
    //
    // All RNA residues (hybrid T, exit R, hairpin H, U-tract U) are
    // emitted onto single PDB chain "R" with globally-sequential resi
    // numbers so 3Dmol draws ONE continuous cartoon ribbon.  We then
    // override the colour per schematic section using the resi ranges
    // that emitAtomicPdbText returned.
    //
    // This block runs AFTER the strandConfigs loop so the atomic model
    // already exists (if applicable).  The per-range calls simply
    // override the zero-colour state of the freshly-loaded model.
    if (options.rna === "atomic" && atomicModelRef.current && rnaResiRanges.length > 0) {
      const RNA_SECTION_COLORS: Record<RnaResiRange["chainId"], string> = {
        T: "#f59e0b",  // amber  — hybrid / σ-trapped
        R: "#10b981",  // green  — exit thread
        H: "#7c3aed",  // violet — terminator hairpin
        U: "#f472b6",  // pink   — U-tract
      };
      for (const range of rnaResiRanges) {
        const sectionColor = RNA_SECTION_COLORS[range.chainId];
        // Build an explicit resi array so the selector works regardless
        // of 3Dmol's internal range-string support.
        const resiArr: number[] = [];
        for (let r = range.startResi; r <= range.endResi; r++) resiArr.push(r);
        viewer.setStyle(
          { model: atomicModelRef.current, chain: "R", resi: resiArr },
          atomicStyleFor(sectionColor),
        );
      }
    }

    // Apply legend-item visibility toggles — override the styles set above
    // by setting hidden chains to an empty style.  Applied last so they win
    // over any per-chain style already set this frame.
    //
    // Three models to consider per chain:
    //   - dynamic model (band spheres)
    //   - atomic model (PDB-parsed sticks + ribbon for atomic-mode strands)
    //   - PDB model (6ALF protein cartoon, atomic overall mode only)
    for (const item of legendItems) {
      if (hiddenItems.has(item.key)) {
        for (const chain of item.dynamicChains) {
          // Dynamic model uses chain IDs like "A", "A_at" interchangeably
          // (band chains have single-char IDs; the legacy "A_at" entries
          // in legendItems are no-ops now since atomic chains live in
          // atomicModelRef instead — but keeping them in the array does
          // no harm and preserves future flexibility).
          viewer.setStyle({ model, chain }, PDB_HIDDEN_STYLE);
          // Also hide on the atomic model — the strand-pill logic above
          // styles atomic chains ("A"/"B"/"R"/"T"/"H"/"U"); legend
          // visibility overrides that.
          if (atomicModelRef.current) {
            viewer.setStyle({ model: atomicModelRef.current, chain }, PDB_HIDDEN_STYLE);
          }
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
  }, [manifest, snapshot, builder, mode, options, showLabels, legendItems, hiddenItems, representation]);

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
        {/* Representation pill — Molecular / Cartoon / Both.  Only
            shown when at least one strand has its per-component pick
            set to "atomic" via the render-mode popup; otherwise the
            picks themselves determine the rendering and the pill
            would be a no-op. */}
        {(options.coding === "atomic"
          || options.template === "atomic"
          || options.rna === "atomic") && (
          <div className="viewer3d-rep-pill" role="group" aria-label="Atomic strand representation">
            {(["molecular", "cartoon", "both"] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={
                  "viewer3d-rep-btn" + (options.representation === r ? " active" : "")
                }
                onClick={() => onOptionsChange({ ...options, representation: r })}
                title={
                  r === "molecular"
                    ? "Show per-residue atoms only (sticks + spheres for backbone, sugar, base)"
                    : r === "cartoon"
                    ? "Show the chunky-bar phosphate-backbone ribbon only (no per-atom detail)"
                    : "Show both the molecular detail and the cartoon ribbon together"
                }
                aria-pressed={options.representation === r}
              >
                {r === "molecular" ? "Molecular" : r === "cartoon" ? "Cartoon" : "Both"}
              </button>
            ))}
          </div>
        )}
      </div>
      {mode === "atomic" && pdbLoading && (
        <div className="viewer3d-status">Loading PDB {PDB_ID} from RCSB…</div>
      )}
      {pdbError && <div className="viewer3d-status error">{pdbError}</div>}
    </div>
  );
}
