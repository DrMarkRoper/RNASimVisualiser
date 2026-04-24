import type { SimulationManifest, Snapshot } from "../types/manifest";

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
 * A geometry frame is everything needed to render a single snapshot.
 * Builders produce one of these per snapshot.
 */
export interface GeometryFrame {
  atoms: Atom[];
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
  build(manifest: SimulationManifest, snapshot: Snapshot): GeometryFrame;
}
