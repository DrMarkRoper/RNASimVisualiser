/**
 * 3Dmol.js per-chain style tables for the two render modes.
 *
 * In atomic mode, chain P (RNAP placeholder) and chain S (procedural σ⁷⁰)
 * are NOT present in the geometry — the PDB model supplies them instead,
 * so those entries are intentionally absent here.
 *
 * Atomic-mode strand chains (suffix `_at`):
 *   A_at — coding-strand DNA atoms (per-residue templates)
 *   B_at — template-strand DNA atoms
 *   T_at — RNA hybrid + σ-bound coil atoms
 *   R_at — RNA exit-channel tail atoms
 *   H_at — terminator-hairpin atoms
 *   U_at — U-tract atoms
 *
 * These are styled with small (0.30 Å radius) spheres + a CPK-ish
 * per-element colour ramp so the per-atom detail reads as a
 * recognisable nucleic-acid backbone + base.  They co-exist with the
 * band chains (A, B, R, T, H, U) in the model; the legend bar's
 * representation pill (Molecular / Bar / Both) controls which are
 * visible by toggling between full styles and `PDB_HIDDEN_STYLE`
 * (= empty StyleSpec, "draw nothing").
 */
import type { RenderMode } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StyleSpec = Record<string, any>;

/** Atomic-mode sphere radius (Å) — small dot at each atom centre, the
 *  detail is carried by the stick bonds rather than the spheres. */
export const ATOMIC_SPHERE_RADIUS = 0.18;
/** Atomic-mode bond stick radius (Å) — chunky enough to read as a
 *  licorice / cylinder representation rather than thin lines.  This
 *  is what gives the rendering its visual mass; matches the look of
 *  PyMOL / VMD's standard "stick" representation. */
export const ATOMIC_STICK_RADIUS = 0.22;

/** Per-element CPK-ish colour map.  Carbon is overridden per chain so
 *  the strand identity (coding vs template vs RNA) stays visually
 *  recognisable; nitrogens / oxygens / phosphorus stand out. */
const ATOM_COLORSCHEME = (carbonHex: string) => ({
  prop: "elem" as const,
  map: {
    C: carbonHex,
    N: "#1e3a8a",  // dark blue — base nitrogens
    O: "#dc2626",  // red — sugar O3'/O4'/O5' + base oxygens
    P: "#f97316",  // orange — phosphate
    H: "#cccccc",  // (unused — templates are heavy-atom only)
  },
});

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
    // Terminator hairpin — violet spheres + lines.  RNA bases that are
    // folding into / have folded into the intrinsic-terminator stem-loop
    // during the `hairpin_forming` phase.  Same colour family as the
    // phase chip (`#7c3aed`) so the timeline and the 3D scene agree.
    H: {
      sphere: { color: "#7c3aed", radius: 1.0, opacity: 0.85 },
      line:   { color: "#7c3aed", linewidth: 2 },
    },
    // U-tract — pink spheres.  3′-most RNA bases that form the rU:dA
    // hybrid downstream of the terminator hairpin (still paired with
    // template at the active site).  Same pink (`#f472b6`) as the
    // SequencePanel `term-utract` highlight so the 3D and the panel
    // agree on which bases are the U-tract.
    U: {
      sphere: { color: "#f472b6", radius: 1.0, opacity: 0.9 },
      line:   { color: "#f472b6", linewidth: 2 },
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
                  1: "#be185d",   // σ4 (deep rose)
                  2: "#db2777",   // σ3 (rose)
                  3: "#ec4899",   // σ2 (pink)
                  4: "#f472b6",   // σ1.1 (light pink, in cleft)
                } } },
      line: { color: "#ec4899", linewidth: 2 },
    },

    // Atomic-mode strand chains (rendered in schematic OVERALL mode
    // when an individual strand has its per-component pick set to
    // `atomic` and `representation !== "band"`).
    //
    // Three layered styles per chain:
    //   • cartoon  — a phosphate-backbone ribbon traced through the
    //                P atoms.  This is the orange / purple band
    //                running along each strand.
    //   • stick    — chunky cylinders for every covalent bond
    //                (intra-residue + inter-residue).  Carbons
    //                white-grey so the bases / sugars read as
    //                neutral ball-and-stick alongside the coloured
    //                ribbon.
    //   • sphere   — small dot at every heavy-atom centre, sized so
    //                bond junctions read crisply without
    //                overpowering the sticks.
    //
    // Carbon colour for sticks is set to a neutral light grey
    // (`#e8eaef`) so the BASE atoms read as standard ball-and-stick;
    // chain identity is carried by the cartoon ribbon's per-chain
    // colour.  Heteroatoms (N/O/P) keep the CPK ramp.
    A_at: {
      cartoon: { color: "#3b82f6", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    B_at: {
      cartoon: { color: "#ef4444", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    R_at: {
      cartoon: { color: "#10b981", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    T_at: {
      cartoon: { color: "#f59e0b", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    H_at: {
      cartoon: { color: "#7c3aed", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    U_at: {
      cartoon: { color: "#f472b6", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
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
    // Terminator hairpin — violet in atomic mode too.
    H: {
      sphere: { color: "#7c3aed", radius: 0.5, opacity: 0.85 },
      line:   { color: "#7c3aed", linewidth: 2 },
    },
    // U-tract — pink in atomic mode too.
    U: {
      sphere: { color: "#f472b6", radius: 0.5, opacity: 0.9 },
      line:   { color: "#f472b6", linewidth: 2 },
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

    // Atomic-mode strand chains — three-layer cartoon + stick +
    // sphere style.  See schematic-mode block above for rationale.
    A_at: {
      cartoon: { color: "#3b82f6", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    B_at: {
      cartoon: { color: "#ef4444", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    R_at: {
      cartoon: { color: "#10b981", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    T_at: {
      cartoon: { color: "#f59e0b", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    H_at: {
      cartoon: { color: "#7c3aed", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
    U_at: {
      cartoon: { color: "#f472b6", style: "rectangle", thickness: 0.4 },
      stick:   { radius: ATOMIC_STICK_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
      sphere:  { radius: ATOMIC_SPHERE_RADIUS, ...ATOM_COLORSCHEME("#e8eaef") },
    },
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
