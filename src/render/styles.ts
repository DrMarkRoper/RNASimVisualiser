/**
 * 3Dmol.js per-chain style tables for the two render modes.
 *
 * In atomic mode, chain P (RNAP placeholder) and chain S (procedural σ⁷⁰)
 * are NOT present in the geometry — the PDB model supplies them instead,
 * so those entries are intentionally absent here.
 */
import type { RenderMode } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StyleSpec = Record<string, any>;

export const STYLES_BY_MODE: Record<RenderMode, Record<string, StyleSpec>> = {
  schematic: {
    // Coding strand — big blue spheres.
    A: { sphere: { color: "#3b82f6", radius: 1.2 } },
    // Template strand — big red spheres.
    B: { sphere: { color: "#ef4444", radius: 1.2 } },
    // Nascent RNA — green spheres (exiting exit channel).
    R: { sphere: { color: "#10b981", radius: 1.0 } },
    // Trapped RNA — amber/gold spheres.  These are 5′-end RNA bases that
    // cannot exit the RNAP because σ1.1 blocks the exit channel while σ⁷⁰
    // is still bound.  Shown coiled inside the RNAP body.
    T: {
      sphere: { color: "#f59e0b", radius: 1.0, opacity: 0.9 },
      line:   { color: "#f59e0b", linewidth: 2 },
    },
    // Backtracked RNA — translucent violet.
    X: { sphere: { color: "#a78bfa", radius: 1.0, opacity: 0.7 } },

    // RNAP — legacy two-blob placeholder (options.rnap === "schematic").
    // Two big grey blobs, semi-transparent.  Mode-switched off when the
    // user picks "mesh" in the render-options popup, in which case the
    // five per-subunit chains below take over.
    P: { sphere: { color: "#9ca3af", radius: 18, opacity: 0.35 } },

    // RNAP — five-subunit mesh (options.rnap === "mesh") on chains
    // Y / Z / Q / K / O.  Cool-grey ramp: αI → αII → β → β′ → ω from
    // light to dark, so the dimer reads as one protein, β/β′ as the
    // cleft jaws, ω as accent.  Colours mirror the offsets in
    // schematic.ts::RNAP_SUBUNITS.
    Y: { sphere: { color: "#cbd5e1", radius: 7,  opacity: 0.55 } },  // α I
    Z: { sphere: { color: "#94a3b8", radius: 7,  opacity: 0.55 } },  // α II
    Q: { sphere: { color: "#64748b", radius: 15, opacity: 0.45 } },  // β
    K: { sphere: { color: "#475569", radius: 16, opacity: 0.45 } },  // β'
    O: { sphere: { color: "#1e293b", radius: 4,  opacity: 0.65 } },  // ω

    // W433 indole — sticks + small sphere, amber/gold.
    W: {
      stick: { color: "#f59e0b", radius: 0.35 },
      sphere: { color: "#f59e0b", radius: 0.5 },
    },

    // σ⁷⁰ — legacy four-domain blob (options.sigma === "schematic").
    // One sphere per domain, connected by a line.  Resi 1..4 = s4 / s3
    // / s2 / s11 (see schematic.ts::LEGACY_SIGMA_DOMAINS).
    S: {
      sphere: { color: "#ec4899", radius: 6, opacity: 0.55 },
      line: { color: "#ec4899", linewidth: 2 },
    },

    // σ⁷⁰ — four-region mesh (options.sigma === "mesh") on chain M.
    // Multi-atom, resi 1..6.  Per-atom colour via 3Dmol's resi-keyed
    // colour-by-residue (deep-rose → light-pink ramp); see SIGMA_ATOMS.
    // Baseline pink + opacity ensures atoms with no per-resi override
    // still render.
    M: {
      sphere: { color: "#ec4899", radius: 5, opacity: 0.6,
                colorscheme: { prop: "resi", map: {
                  1: "#be185d", 2: "#be185d",   // σ4 (deep rose)
                  3: "#db2777",                  // σ3 (rose)
                  4: "#ec4899", 5: "#ec4899",   // σ2 (pink)
                  6: "#f472b6",                  // σ1.1 (light pink, in cleft)
                } } },
      line: { color: "#ec4899", linewidth: 2 },
    },
  },
  atomic: {
    // Coding strand — small spheres + line backbone trace.
    A: {
      sphere: { color: "#3b82f6", radius: 0.5 },
      line: { color: "#3b82f6", linewidth: 2 },
    },
    B: {
      sphere: { color: "#ef4444", radius: 0.5 },
      line: { color: "#ef4444", linewidth: 2 },
    },
    R: {
      sphere: { color: "#10b981", radius: 0.5 },
      line: { color: "#10b981", linewidth: 2 },
    },
    // Trapped RNA (σ-blocked) — amber in atomic mode too.
    T: {
      sphere: { color: "#f59e0b", radius: 0.5, opacity: 0.9 },
      line:   { color: "#f59e0b", linewidth: 2 },
    },
    X: {
      sphere: { color: "#a78bfa", radius: 0.5, opacity: 0.7 },
      line: { color: "#a78bfa", linewidth: 2 },
    },
    // W433 stays as stick + sphere — visible inside the PDB's protein mesh.
    W: {
      stick: { color: "#f59e0b", radius: 0.5 },
      sphere: { color: "#f59e0b", radius: 0.8 },
    },
    // P and S are absent in atomic geometry — PDB supplies them.
  },
};

/**
 * Style applied to the PDB model (6ALF) in atomic mode.
 *
 * Chain letter convention for the 6ALF entry we fetch from RCSB:
 *   Chains A, B       = α subunits
 *   Chain  C          = β subunit
 *   Chain  D          = β' subunit
 *   Chain  E          = ω subunit
 *   Chain  F          = σ⁷⁰    ← opacity faded by sigma70Presence
 *   Chain  T          = template DNA    ← hidden (we draw our own)
 *   Chain  N          = non-template DNA ← hidden
 *
 * If RCSB returns a revised chain mapping in the future these selectors
 * will need re-checking; the viewer logs any chain it cannot style.
 */
export const PDB_PROTEIN_STYLE: StyleSpec = {
  cartoon: { color: "spectrum", opacity: 0.85 },
};

export const PDB_SIGMA_STYLE = (presence: number): StyleSpec => ({
  cartoon: { color: "#ec4899", opacity: Math.max(0.0, 0.9 * presence) },
});

export const PDB_HIDDEN_STYLE: StyleSpec = {};

/** Chains in the PDB entry we hide because our procedural overlay covers them. */
export const PDB_NUCLEIC_CHAINS = ["T", "N"];
export const PDB_SIGMA_CHAINS = ["F"];
export const PDB_PROTEIN_CHAINS = ["A", "B", "C", "D", "E"];
