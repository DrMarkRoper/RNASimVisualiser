import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { RenderOptions } from "../components/RenderOptionsButton";

export type RenderMode = "schematic" | "atomic";

/**
 * Minimal atom record. Consumed by 3Dmol.js via `addAtoms` / `addModel`.
 * We emit a tiny PDB-like document so 3Dmol can apply its own styling atoms.
 */
export interface Atom {
  elem: string;          // element symbol: C, N, O, P, ...
  x: number;
  y: number;
  z: number;
  resn: string;          // residue name: DA/DT/DG/DC, A/U/G/C, TRP, etc.
  resi: number;          // residue index (1-based)
  chain: string;         // A = coding, B = template, R = RNA, P = protein (W433)
  serial: number;        // atom serial (1-based, monotonic)
  atomName?: string;     // optional: CA, P, N1, ...
  bonds?: number[];      // serials of bonded neighbours (for line/stick style)
  bondOrder?: number[];  // parallel to bonds; 1 = single
}

/**
 * A persistent on-canvas text label drawn alongside the geometry.  The
 * schematic builder emits one per RNAP subunit (α / β / β′ / ω) and one
 * per σ⁷⁰ region (1.1 / 2 / 3 / 4) so the viewer can name them without
 * forcing the user to hover.  Atomic mode does not emit any — the PDB
 * cartoon plus hover labels carry that information.
 */
export interface MeshLabel {
  /** Stable identifier for label diffing across frames (e.g. "subunit:beta"). */
  id: string;
  /** Visible label text (kept short — these are on-canvas, not tooltips). */
  text: string;
  /** Anchor point in scene coordinates (Å). */
  position: [number, number, number];
  /** 0..1 opacity multiplier — used to fade σ region labels with σ presence. */
  opacity?: number;
}

/**
 * A geometry frame is everything needed to render a single snapshot.
 * Builders produce one of these per snapshot.
 */
export interface GeometryFrame {
  atoms: Atom[];
  /** Persistent on-canvas labels (subunit names, region names, …). */
  labels?: MeshLabel[];
  /** Optional hints the viewer may use to style / focus the scene. */
  hints: {
    rnapCenter: [number, number, number];
    /** suggested camera distance */
    viewDistance: number;
    /**
     * σ⁷⁰ presence on the holoenzyme, 0 (fully released) to 1 (bound).
     * Drives chain-S fade in schematic mode and chain-F (or mapped sigma chain)
     * opacity on the PDB model in atomic mode.
     */
    sigma70Presence: number;
  };
}

export interface GeometryBuilder {
  readonly mode: RenderMode;
  /**
   * Build a single geometry frame.  `options` lets each per-component
   * representation be selected independently — e.g. RNAP as the legacy
   * two-blob "schematic" placeholder vs. the per-subunit "mesh", σ⁷⁰ as
   * a four-domain blob vs. a four-region mesh, etc.  When the overall
   * mode is "atomic" the procedural protein chains are filtered out
   * downstream regardless of these per-component picks (see atomic.ts).
   */
  build(
    manifest: SimulationManifest,
    snapshot: Snapshot,
    options: RenderOptions,
  ): GeometryFrame;
}
