/**
 * Schematic (procedural) renderer.
 *
 * Draws a stylised, inspectable scene — not atomically accurate, but animates
 * smoothly because all positions are deterministic functions of the snapshot.
 *
 * Scene components (this file):
 *   • B-form double helix for both strands, upstream + downstream of bubble
 *   • Single-stranded coding & template strands inside the bubble
 *   • RNAP body: five-subunit mesh — α₂ (chains Y, Z), β (Q), β′ (K), ω (O)
 *     with on-canvas labels.  Replaces the previous two-sphere placeholder.
 *   • W433 indole ring as 10 atoms, lerped by snapshot.w433_depth
 *   • Nascent RNA thread emerging from the exit channel
 *   • Trapped RNA (chain T): RNA bases inside RNAP that cannot exit because
 *     the σ1.1 domain blocks the exit channel while σ⁷⁰ is still bound.
 *     Shown in amber alongside the normal RNA.
 *   • σ⁷⁰ four-region mesh on chain S (resi 1..6, multi-atom regions for
 *     σ4 / σ3 / σ2 / σ1.1) with on-canvas region labels.
 *
 * Animations driven by snapshot.phase:
 *   "approaching"  — σ⁷⁰ domains converge from spread positions (assembly)
 *                    then the whole holoenzyme descends to the promoter.
 *   "detaching"    — RNAP lifts off the DNA, bubble collapses (handled in
 *                    Python snapshot fields), RNA drifts with RNAP.
 *
 * TODO (geometry-builder milestones):
 *   3. Template 90° bend inside the active-site cleft
 *   4. Coding strand loop over the RNAP clamp & downstream re-annealing
 *   7. Backtracked RNA in secondary channel when backtrack_steps > 0
 */
import type { Atom, GeometryBuilder, GeometryFrame, MeshLabel } from "./types";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { RenderOptions } from "../components/RenderOptionsButton";
import { getSigma70Presence } from "../utils/sigma";

// B-form helix geometry (standard values).
const RISE_PER_BP = 3.4;          // Å
const TWIST_PER_BP = (36 * Math.PI) / 180; // rad
const HELIX_RADIUS = 10;          // Å (visually inflated for readability)

// RNA:DNA hybrid length — bases 3′-ward of this from the RNAP active site
// are inside the transcription bubble.  Bases upstream (5′ end of RNA) are
// in the RNAP body's exit channel — or, while σ⁷⁰ is bound, trapped there
// because σ1.1 blocks the exit (see "trapped RNA" section below).
const HYBRID_LEN_SCHEMATIC = 9;

// Vertical lift applied to RNAP during "approaching" and "detaching" phases.
const LIFT_HEIGHT_ANG = 90; // Å above normal Y-position

// Map a TSS-relative coordinate to a strand index along the full helix.
function coordToIndex(coord: number, tssIndex: number): number {
  return coord < 0 ? tssIndex + coord : tssIndex + coord - 1;
}

/**
 * Safe backbone access — clamps the index to [0, backbone.length - 1] so a
 * sequence where tssIndex < |coord| (very short upstream region) or a
 * mis-configured manifest never throws "Cannot read properties of undefined".
 */
function safeBackboneIdx(coord: number, tssIndex: number, boneLen: number): number {
  const raw = coordToIndex(coord, tssIndex);
  return Math.max(0, Math.min(raw, boneLen - 1));
}

interface BaseAxisPoint {
  idx: number;           // 0-based index along coding_strand
  coord: number;         // TSS-relative position (+1, +2, ..., never 0)
  axis: [number, number, number]; // helix axis position
  twist: number;         // rotation angle around axis
}

/**
 * Compute the helical backbone path for every base pair in the full sequence.
 */
function computeBackbone(manifest: SimulationManifest): BaseAxisPoint[] {
  const len = manifest.sequence.sequence_length;
  const tssIndex = manifest.sequence.tss_index;
  const out: BaseAxisPoint[] = [];
  for (let i = 0; i < len; i++) {
    const delta = i - tssIndex;
    const coord = delta < 0 ? delta : delta + 1;
    const axisZ = (i - tssIndex) * RISE_PER_BP;
    out.push({
      idx: i,
      coord,
      axis: [0, 0, axisZ],
      twist: i * TWIST_PER_BP,
    });
  }
  return out;
}

/**
 * Strand position for a backbone point.  Inside the bubble, displacement is
 * exaggerated so the two single strands visually separate.
 */
function strandPosition(
  pt: BaseAxisPoint,
  strandSign: 1 | -1,
  melted: boolean,
): [number, number, number] {
  const [ax, ay, az] = pt.axis;
  const r = melted ? HELIX_RADIUS * 1.8 : HELIX_RADIUS;
  const phase = strandSign === 1 ? pt.twist : pt.twist + Math.PI;
  const yLift = melted ? strandSign * 4 : 0;
  return [ax + r * Math.cos(phase), ay + r * Math.sin(phase) + yLift, az];
}

/** Map DNA base char to 3Dmol-friendly residue name. */
function dnaResn(base: string): string {
  switch (base.toUpperCase()) {
    case "A": return "DA";
    case "T": return "DT";
    case "G": return "DG";
    case "C": return "DC";
    default:  return "DN";
  }
}

function rnaResn(base: string): string {
  switch (base.toUpperCase()) {
    case "A":       return "A";
    case "T":
    case "U":       return "U";
    case "G":       return "G";
    case "C":       return "C";
    default:        return "N";
  }
}

// -------------------------------------------------------------------------
// Phase-range cache — used by the schematic to compute lift fractions for
// "approaching" and "detaching" without O(n) scans on every frame.
// -------------------------------------------------------------------------

interface PhaseRange {
  start: number;
  end: number;
}
interface PhaseRanges {
  approach: PhaseRange | null;
  detach: PhaseRange | null;
}

const phaseRangesCache = new WeakMap<SimulationManifest, PhaseRanges>();

function getPhaseRanges(manifest: SimulationManifest): PhaseRanges {
  const cached = phaseRangesCache.get(manifest);
  if (cached) return cached;

  let apStart = -1, apEnd = -1;
  let dtStart = -1, dtEnd = -1;

  for (const s of manifest.snapshots) {
    if (s.phase === "approaching") {
      if (apStart < 0) apStart = s.frame;
      apEnd = s.frame;
    }
    if (s.phase === "detaching") {
      if (dtStart < 0) dtStart = s.frame;
      dtEnd = s.frame;
    }
  }

  const result: PhaseRanges = {
    approach: apStart >= 0 ? { start: apStart, end: apEnd } : null,
    detach:   dtStart >= 0 ? { start: dtStart, end: dtEnd } : null,
  };
  phaseRangesCache.set(manifest, result);
  return result;
}

/**
 * Compute two fractions used for the "approaching" and "detaching" animations:
 *
 *   liftFactor  — 0 = RNAP/σ sitting on DNA, 1 = maximum lift above DNA.
 *                 Rises from 1→0 during "approaching", stays 0 normally,
 *                 rises 0→1 during "detaching".
 *
 *   assembleFraction — 0 = σ domains spread apart (pre-assembly), 1 = fully
 *                      assembled onto RNAP body.  Goes 0→1 in the first 40 %
 *                      of the "approaching" frames, stays 1 thereafter.
 */
function computeAnimationFractions(
  manifest: SimulationManifest,
  snapshot: Snapshot,
): { liftFactor: number; assembleFraction: number; detachFraction: number } {
  const ranges = getPhaseRanges(manifest);
  const frame = snapshot.frame;

  let liftFactor = 0;
  let assembleFraction = 1;
  let detachFraction = 0;

  if (snapshot.phase === "approaching" && ranges.approach) {
    const { start, end } = ranges.approach;
    const span = Math.max(end - start, 1);
    const progress = (frame - start) / span; // 0 → 1 across all approach frames
    liftFactor = 1 - progress;                // starts high, goes to 0
    assembleFraction = Math.min(1, progress / 0.4); // assembles over first 40 %
  }

  if (snapshot.phase === "detaching" && ranges.detach) {
    const { start, end } = ranges.detach;
    const span = Math.max(end - start, 1);
    detachFraction = (frame - start) / span;  // 0 → 1 across detach frames
    liftFactor = detachFraction;               // RNAP rises as RNA drifts away
    assembleFraction = 1;                      // σ already gone during detach
  }

  return { liftFactor, assembleFraction, detachFraction };
}

// -------------------------------------------------------------------------
// RNAP core subunit layout (α₂ββ′ω) — schematic mode only.
//
// The body is centred on rnapCenter = (0, liftY, rnapAxisZ).  Each subunit
// is a sphere (or two for the α dimer) at a fixed offset relative to that
// centre.  Atomic mode uses the 6ALF cartoon directly and ignores all this.
//
// Chain letters are chosen to be unique within the schematic dynamic model
// (which already uses A=coding, B=template, R=RNA, T=trapped, X=backtrack,
// P=RNAP placeholder, W=W433, S=σ).  They have no relationship to PDB chain
// conventions in 6ALF, where A/B/C/D/E mean the canonical subunits.
//
// Visual rationale: a five-element mesh that reads as "core RNAP" without
// requiring atomic accuracy.  The two large opposing spheres (β top, β′
// bottom) form the cleft the DNA passes through; the α dimer sits behind
// the cleft on the assembly platform; ω is tucked under β′.
// -------------------------------------------------------------------------

/** Bounding-region helper — local coordinates relative to rnapCenter. */
interface SubunitDef {
  /** Single-character chain identifier (must be unique in schematic dyn model). */
  chain: string;
  /** Residue index within the chain — used for hover-label disambiguation. */
  resi: number;
  /** Short on-canvas label (kept compact: "α I", "β'", …). */
  label: string;
  /** Centre offset relative to rnapCenter, in Å. */
  offset: [number, number, number];
  /** Sphere radius in Å (used both for styling and label-anchor placement). */
  radius: number;
  /** Hex colour for the sphere (mirrored in styles.ts). */
  color: string;
}

const RNAP_SUBUNITS: SubunitDef[] = [
  // α dimer — assembly platform on the back side of the cleft.  Two copies
  // of the same protein; placed symmetrically along Z so they read as a
  // dimer.  Lighter / cooler than β & β′ to push them visually backwards.
  { chain: "Y", resi: 1, label: "α I",  offset: [-12, -3, -12], radius: 7,  color: "#cbd5e1" },
  { chain: "Z", resi: 1, label: "α II", offset: [-12, -3,  12], radius: 7,  color: "#94a3b8" },

  // β subunit — upper jaw of the cleft (lobe + flap).  The downstream DNA
  // passes through the gap between this and β′ in real RNAP; here it sits
  // above the helix axis (y = 0) so the existing strand spheres at y ± 10
  // visually thread between β and β′.
  { chain: "Q", resi: 1, label: "β",    offset: [  0, 22,   0], radius: 15, color: "#64748b" },

  // β′ subunit — lower jaw / clamp / bridge helix / Mg²⁺ active site.  Drawn
  // a touch larger and darker than β so the Mg-active-site half of the cleft
  // reads as the "business end".
  { chain: "K", resi: 1, label: "β'",   offset: [  0,-22,   0], radius: 16, color: "#475569" },

  // ω subunit — small β′ folding chaperone, tucked behind/below.
  { chain: "O", resi: 1, label: "ω",    offset: [-14,-12,  -3], radius: 4,  color: "#1e293b" },
];

// -------------------------------------------------------------------------
// σ⁷⁰ — legacy four-domain blob (chain S, resi 1..4).
//
// Used when `options.sigma === "schematic"` — preserves the original simple
// representation: one sphere per domain, connected by a line.  Each domain
// has its own `assemblySpread` so they visibly converge during approach;
// kept as-is for the legacy view.  The newer "mesh" mode below uses a
// different chain (M) and moves σ as a single rigid body.
// -------------------------------------------------------------------------

interface LegacySigmaDomain {
  label: string;
  coord: number;          // TSS-relative position on coding strand
  boundOffset: [number, number]; // (dy, dx) relative to helix axis at coord
  assemblySpread: [number, number]; // (dy_extra, dx_extra) added when assembly=0
}

const LEGACY_SIGMA_DOMAINS: LegacySigmaDomain[] = [
  { label: "s4",  coord: -35, boundOffset: [28,  4],  assemblySpread: [30, 40] },
  { label: "s3",  coord: -22, boundOffset: [32,  0],  assemblySpread: [50, 20] },
  { label: "s2",  coord: -10, boundOffset: [28, -4],  assemblySpread: [40, -30] },
  { label: "s11", coord:  -2, boundOffset: [20, -8],  assemblySpread: [20, -50] },
];

// -------------------------------------------------------------------------
// σ⁷⁰ — four-region mesh (chain M, resi 1..6).
//
// Used when `options.sigma === "mesh"`.  Each region is one or more atoms
// on chain "M" (kept distinct from the legacy chain "S" so each chain owns
// its own colorscheme without conflict).
//
// Region layout (TSS-relative coords match the SequencePanel labelling):
//   σ4    — recognises -35 hexamer via HTH motif (two close spheres).
//   σ3    — spacer / extended -10 (one sphere between σ4 and σ2).
//   σ2    — recognises -10 hexamer; region 2.3 is the W433 melt wedge.
//           Two spheres: 2.4 recognition + 2.3 melt-wedge anchor.
//   σ1.1  — autoinhibitory NTD; sits *inside* the RNAP cleft when bound,
//           occluding the main channel.  Anchored to rnapCenter rather than
//           to a coding-strand coord (the others bind DNA directly).
//
// Biological correction (vs. legacy mode): σ⁷⁰ is a *single polypeptide*,
// not a quaternary assembly of four parts.  The legacy mode lets each
// region "drift in" with its own per-region spread vector, which reads
// (incorrectly) as four pieces snapping together.  The mesh mode instead
// applies a single uniform translation (SIGMA_APPROACH_OFFSET on entry,
// SIGMA_RELEASE_OFFSET on exit) so the whole molecule moves as a rigid
// body — consistent with how the RNAP subunits are arranged at fixed
// offsets relative to rnapCenter.
//
// Hover labels on chain M are resolved off `resi` in pdbLabels.ts.
// -------------------------------------------------------------------------

/**
 * Pre-assembly offset for the whole σ⁷⁰ molecule (uniform across regions).
 * During the first 40 % of the "approaching" frames σ enters from this
 * offset and converges onto its bound pose, holding its rigid 4-region
 * shape throughout the translation.
 */
const SIGMA_APPROACH_OFFSET: [number, number, number] = [-15, 70, -25];

/**
 * Released-pose offset (uniform across regions).  When σ⁷⁰ leaves the
 * holoenzyme on promoter escape it translates as a single rigid body.
 */
const SIGMA_RELEASE_OFFSET: [number, number, number] = [40, 78, 5];

/** Anchor strategy — region 1.1 sits inside RNAP, the others sit on DNA. */
type SigmaAnchor = { kind: "promoter"; coord: number } | { kind: "rnap" };

interface SigmaAtomDef {
  /** Stable resi for hover lookup (1..6 in build order; see pdbLabels.ts). */
  resi: number;
  /** Region this atom belongs to ("4", "3", "2", "1.1"). */
  region: "4" | "3" | "2" | "1.1";
  /** Where the region anchors when σ is bound. */
  anchor: SigmaAnchor;
  /** Bound offset relative to the anchor (dx, dy, dz) in Å. */
  boundOffset: [number, number, number];
  /**
   * Marks the atom whose position drives the on-canvas region label, when
   * the region has multiple atoms.  Exactly one per region carries this flag.
   */
  labelAnchor?: boolean;
  /** Region label text (only on the labelAnchor atom). */
  label?: string;
}

const SIGMA_ATOMS: SigmaAtomDef[] = [
  // -- Region 4 (HTH on -35) -------------------------------------------------
  {
    resi: 1, region: "4",
    anchor: { kind: "promoter", coord: -35 },
    boundOffset: [4, 26, 0],
    labelAnchor: true, label: "σ4 (-35)",
  },
  {
    resi: 2, region: "4",
    anchor: { kind: "promoter", coord: -34 },
    boundOffset: [4, 30, 0],
  },

  // -- Region 3 (spacer / extended -10) -------------------------------------
  {
    resi: 3, region: "3",
    anchor: { kind: "promoter", coord: -22 },
    boundOffset: [0, 32, 0],
    labelAnchor: true, label: "σ3",
  },

  // -- Region 2 (recognises -10; 2.3 W433 wedge) ----------------------------
  {
    resi: 4, region: "2",
    anchor: { kind: "promoter", coord: -10 },
    boundOffset: [-4, 28, 0],
    labelAnchor: true, label: "σ2 (-10)",
  },
  {
    resi: 5, region: "2",
    anchor: { kind: "promoter", coord: -12 },
    boundOffset: [-2, 26, 0],
  },

  // -- Region 1.1 (autoinhibitory NTD inside RNAP cleft) --------------------
  // Anchored on rnapCenter, not on a promoter coord.  When σ is bound, this
  // sphere sits *inside* the RNAP body (occluding the main channel).
  {
    resi: 6, region: "1.1",
    anchor: { kind: "rnap" },
    boundOffset: [-2, 0, 4],
    labelAnchor: true, label: "σ1.1",
  },
];

// -------------------------------------------------------------------------
// W433 indole ring
// -------------------------------------------------------------------------

/**
 * 10-atom idealised indole ring (W433 side-chain surrogate).
 */
const INDOLE_TEMPLATE: Array<{ name: string; elem: string; x: number; y: number; z: number }> = [
  { name: "CG",  elem: "C", x:  0.00, y: 0.00, z: 0.00 },
  { name: "CD1", elem: "C", x:  1.36, y: 0.00, z: 0.00 },
  { name: "NE1", elem: "N", x:  2.10, y: 1.18, z: 0.00 },
  { name: "CE2", elem: "C", x:  1.24, y: 2.20, z: 0.00 },
  { name: "CD2", elem: "C", x: -0.08, y: 1.43, z: 0.00 },
  { name: "CE3", elem: "C", x: -1.22, y: 2.22, z: 0.00 },
  { name: "CZ3", elem: "C", x: -1.05, y: 3.60, z: 0.00 },
  { name: "CH2", elem: "C", x:  0.25, y: 4.17, z: 0.00 },
  { name: "CZ2", elem: "C", x:  1.39, y: 3.59, z: 0.00 },
  { name: "CA",  elem: "C", x: -1.20, y: -1.00, z: 0.00 },
];

// -------------------------------------------------------------------------
// Builder
// -------------------------------------------------------------------------

class SchematicBuilder implements GeometryBuilder {
  readonly mode = "schematic" as const;

  build(
    manifest: SimulationManifest,
    snapshot: Snapshot,
    options: RenderOptions,
  ): GeometryFrame {
    const backbone = computeBackbone(manifest);
    const atoms: Atom[] = [];
    let serial = 1;

    const tssIndex = manifest.sequence.tss_index;
    const boneLen  = backbone.length;
    const bubbleLoIdx = safeBackboneIdx(snapshot.bubble_upstream,   tssIndex, boneLen);
    const bubbleHiIdx = safeBackboneIdx(snapshot.bubble_downstream, tssIndex, boneLen);
    const rnapIdx     = safeBackboneIdx(snapshot.position,          tssIndex, boneLen);

    const coding   = manifest.sequence.coding_strand;
    const template = manifest.sequence.template_strand;

    // σ⁷⁰ presence — monotonic function of simulation time.
    const presence = getSigma70Presence(manifest, snapshot);

    // Animation fractions for "approaching" and "detaching" phases.
    const { liftFactor, assembleFraction, detachFraction } = computeAnimationFractions(manifest, snapshot);
    const liftY = LIFT_HEIGHT_ANG * liftFactor;

    // During approaching / detaching, the RNAP center also shifts in Y.
    // rnapIdx is already clamped by safeBackboneIdx above.
    const rnapAxisZ = backbone[rnapIdx].axis[2];
    const rnapCenter: [number, number, number] = [0, liftY, rnapAxisZ];

    // ----------------------------------------------------------------
    // DNA strands (chains A and B)
    // ----------------------------------------------------------------

    let prevA: number | null = null;
    for (const pt of backbone) {
      const melted = pt.idx >= bubbleLoIdx && pt.idx <= bubbleHiIdx;
      const [x, y, z] = strandPosition(pt, +1, melted);
      const atom: Atom = {
        elem: "P",
        x, y, z,
        resn: dnaResn(coding[pt.idx]),
        resi: pt.idx + 1,
        chain: "A",
        serial: serial++,
        atomName: "P",
      };
      if (prevA !== null) { atom.bonds = [prevA]; atom.bondOrder = [1]; }
      prevA = atom.serial;
      atoms.push(atom);
    }

    let prevB: number | null = null;
    for (const pt of backbone) {
      const melted = pt.idx >= bubbleLoIdx && pt.idx <= bubbleHiIdx;
      const [x, y, z] = strandPosition(pt, -1, melted);
      const atom: Atom = {
        elem: "P",
        x, y, z,
        resn: dnaResn(template[pt.idx]),
        resi: pt.idx + 1,
        chain: "B",
        serial: serial++,
        atomName: "P",
      };
      if (prevB !== null) { atom.bonds = [prevB]; atom.bondOrder = [1]; }
      prevB = atom.serial;
      atoms.push(atom);
    }

    // ----------------------------------------------------------------
    // RNAP body — branched explicitly on all three options.rnap values.
    //
    //   "schematic" → legacy two-Fe-sphere placeholder on chain P, no
    //                 labels.  The original pre-mesh visual.
    //
    //   "mesh"      → five-subunit mesh on chains Y / Z / Q / K / O
    //                 (αI, αII, β, β′, ω) with one on-canvas label
    //                 per subunit.
    //
    //   "atomic"    → procedural geometry suppressed.  Two cases:
    //                 • Overall mode is "atomic" (all components are
    //                   atomic): atomic.ts strips procedural protein
    //                   chains and the 6ALF PDB cartoon supplies the
    //                   subunits via chains A/B/C/D/E.
    //                 • Overall mode is "schematic" (mixed): the PDB
    //                   isn't loaded, so per-component atomic in mixed
    //                   mode isn't yet supported — fall back to the
    //                   legacy two-blob placeholder so the user still
    //                   sees a body.  TODO: when selective PDB loading
    //                   lands, render only chains A/B/C/D/E here.
    //
    // The whole assembly lifts together by liftY during "approaching" /
    // "detaching" in any branch.
    // ----------------------------------------------------------------
    const labels: MeshLabel[] = [];
    const emitLegacyRnap = () => {
      atoms.push(
        { elem: "Fe", x: 0, y:  25 + liftY, z: rnapAxisZ, resn: "RPA", resi: 1, chain: "P", serial: serial++, atomName: "CA" },
        { elem: "Fe", x: 0, y: -25 + liftY, z: rnapAxisZ, resn: "RPA", resi: 2, chain: "P", serial: serial++, atomName: "CA" },
      );
    };
    if (options.rnap === "mesh") {
      for (const su of RNAP_SUBUNITS) {
        const [dx, dy, dz] = su.offset;
        const sx = rnapCenter[0] + dx;
        const sy = rnapCenter[1] + dy;
        const sz = rnapCenter[2] + dz;
        atoms.push({
          elem: "C",
          x: sx, y: sy, z: sz,
          resn: "RNP",
          resi: su.resi,
          chain: su.chain,
          serial: serial++,
          atomName: "CA",
        });
        // Label anchored just above the top of the sphere so it doesn't
        // overlap with the geometry.  Y is the "up" screen axis after the
        // canonical 90° camera rotation.
        labels.push({
          id: `subunit:${su.chain}`,
          text: su.label,
          position: [sx, sy + su.radius + 3, sz],
          opacity: 1,
        });
      }
    } else if (options.rnap === "schematic") {
      emitLegacyRnap();
    } else {
      // options.rnap === "atomic" — fall through to the legacy placeholder
      // when overall mode is schematic (atomic.ts strips it when overall
      // mode is atomic; PDB chains A/B/C/D/E supply the body in that case).
      emitLegacyRnap();
    }

    // ----------------------------------------------------------------
    // W433 indole (chain W) — only while σ⁷⁰ is attached.
    // Drifts away with σ⁷⁰ as presence fades.
    // ----------------------------------------------------------------
    if (presence > 0.02) {
      const w433TargetCoord = -11;
      const w433Idx = safeBackboneIdx(w433TargetCoord, tssIndex, boneLen);
      const targetZ = backbone[w433Idx].axis[2];
      const depth = snapshot.w433_depth;

      const retractedCenter: [number, number, number] = [25, 0, targetZ];
      const insertedCenter:  [number, number, number] = [HELIX_RADIUS * 0.6, 0, targetZ];
      const boundX = retractedCenter[0] * (1 - depth) + insertedCenter[0] * depth;
      const boundY = retractedCenter[1] * (1 - depth) + insertedCenter[1] * depth;
      const boundZ = retractedCenter[2];

      const releasedCenter: [number, number, number] = [38, 68, targetZ];

      const cx = boundX * presence + releasedCenter[0] * (1 - presence);
      const cy = (boundY * presence + releasedCenter[1] * (1 - presence)) + liftY;
      const cz = boundZ * presence + releasedCenter[2] * (1 - presence);

      for (const a of INDOLE_TEMPLATE) {
        atoms.push({
          elem: a.elem,
          x: cx + a.x, y: cy + a.y, z: cz + a.z,
          resn: "TRP", resi: 433, chain: "W",
          serial: serial++, atomName: a.name,
        });
      }
    }

    // ----------------------------------------------------------------
    // Nascent RNA (chains R and T)
    //
    // Biological note on detachment order (intrinsic termination):
    //   The GC-rich hairpin folds in the exit channel and physically ejects
    //   the 3′ end of the RNA from the active site.  The weak rU:dA hybrid
    //   (U-tract) then melts and the complete transcript is released BEFORE
    //   (or simultaneous with) RNAP dissociation from DNA.  The RNA never
    //   remains threaded through a departing RNAP.
    //
    //   Rendering rule: during "detaching" the RNA anchor is fixed at the
    //   DNA level (y = 0, z = last RNAP position) and drifts outward in −X,
    //   while RNAP lifts independently in +Y.  The two trajectories visibly
    //   diverge, communicating that the RNA has already been released.
    //
    // When σ⁷⁰ is present, the σ1.1 domain physically blocks the RNAP exit
    // channel, so RNA cannot leave even if its length exceeds the 9-nt hybrid
    // window.  The excess bases (5′ end) are coiled inside the RNAP body.
    //
    // Chain R — bases that exit normally (or would if not blocked):
    //   • While σ present AND rna_length > HYBRID_LEN: only the 3′
    //     HYBRID_LEN bases are drawn here (they're still in the hybrid).
    //   • While σ absent: all bases drawn here on the exit thread.
    //
    // Chain T — "trapped" bases (5′ excess, σ-blocked):
    //   • Only rendered when σ is present AND rna.length > HYBRID_LEN.
    //   • Drawn as a tight cluster coiled near the RNAP body interior,
    //     coloured amber to signal they cannot exit.
    // ----------------------------------------------------------------
    const rna = snapshot.rna_sequence;
    const sigmaPresent = presence > 0.05;
    const hybridWindowStart = Math.max(0, rna.length - HYBRID_LEN_SCHEMATIC);
    const hasTrappedRNA = sigmaPresent && hybridWindowStart > 0;
    const armLen = 4 * rna.length;

    // RNA anchor: normally tracks rnapCenter (RNA threads through RNAP).
    // During "detaching" the RNA is already released — anchor it to the
    // DNA-level position and drift it outward in −X so it visually separates
    // from the lifting RNAP body.
    const RNA_DRIFT_X = 50; // Å total lateral drift of released transcript
    const rnaAnchor: [number, number, number] =
      snapshot.phase === "detaching"
        ? [rnapCenter[0] - RNA_DRIFT_X * detachFraction, 0, rnapCenter[2]]
        : rnapCenter;

    // Chain T — trapped RNA coiled inside RNAP body
    if (hasTrappedRNA) {
      let prevT: number | null = null;
      for (let k = 0; k < hybridWindowStart; k++) {
        const base = rna[k];
        // Tight coil near rnapCenter interior
        const angle = (k / Math.max(hybridWindowStart - 1, 1)) * 2 * Math.PI;
        const coilR = 10; // Å — well inside the RNAP sphere (radius 18)
        const x = rnapCenter[0] + coilR * Math.cos(angle);
        const y = rnapCenter[1] + coilR * Math.sin(angle);
        const z = rnapCenter[2] + k * 0.6;
        const atom: Atom = {
          elem: "O",  // oxygen → amber in default 3Dmol colouring (overridden by chain style)
          x, y, z,
          resn: rnaResn(base),
          resi: k + 1,
          chain: "T",
          serial: serial++,
          atomName: "P",
        };
        if (prevT !== null) { atom.bonds = [prevT]; atom.bondOrder = [1]; }
        prevT = atom.serial;
        atoms.push(atom);
      }
    }

    // Chain R — exiting RNA (or hybrid-only RNA when σ is present)
    {
      let prevR: number | null = null;
      const startK = hasTrappedRNA ? hybridWindowStart : 0;
      for (let k = startK; k < rna.length; k++) {
        const base = rna[k];
        const t = (k - startK) / Math.max(rna.length - startK - 1, 1);
        const x = rnaAnchor[0] - t * armLen - 5;
        const y = rnaAnchor[1] + Math.sin(t * Math.PI) * 10 + 10;
        const z = rnaAnchor[2] + k * 0.8;
        const atom: Atom = {
          elem: "P",
          x, y, z,
          resn: rnaResn(base),
          resi: k + 1,
          chain: "R",
          serial: serial++,
          atomName: "P",
        };
        if (prevR !== null) { atom.bonds = [prevR]; atom.bondOrder = [1]; }
        prevR = atom.serial;
        atoms.push(atom);
      }
    }

    // ----------------------------------------------------------------
    // Backtracked RNA (chain X) — displaced thread into secondary channel.
    // ----------------------------------------------------------------
    if (snapshot.backtrack_steps > 0) {
      let prevX: number | null = null;
      for (let k = 0; k < snapshot.backtrack_steps; k++) {
        const x = rnapCenter[0] + 5 + k * 3;
        const y = rnapCenter[1] - 15;
        const z = rnapCenter[2] - k * 0.5;
        const atom: Atom = {
          elem: "P", x, y, z,
          resn: "N", resi: k + 1, chain: "X",
          serial: serial++, atomName: "P",
        };
        if (prevX !== null) { atom.bonds = [prevX]; atom.bondOrder = [1]; }
        prevX = atom.serial;
        atoms.push(atom);
      }
    }

    // ----------------------------------------------------------------
    // σ⁷⁰ — branched explicitly on all three options.sigma values.
    //
    //   "schematic" → legacy four-domain blob on chain S (resi 1..4,
    //                 one sphere per domain).  Each domain has its own
    //                 per-domain `assemblySpread`, preserving the
    //                 original "regions converging onto the body"
    //                 animation verbatim.
    //
    //   "mesh"      → four-region mesh on chain M (resi 1..6 — see
    //                 SIGMA_ATOMS).  Moves as a *rigid body*: a single
    //                 SIGMA_APPROACH_OFFSET / SIGMA_RELEASE_OFFSET
    //                 applies to every region, consistent with σ⁷⁰
    //                 being one polypeptide.  Each region contributes
    //                 one on-canvas label that fades with σ presence.
    //
    //   "atomic"    → procedural geometry suppressed.
    //                 • Overall mode = atomic: atomic.ts strips chains
    //                   S and M; PDB chain F supplies σ⁷⁰ with the
    //                   existing presence-driven cartoon fade.
    //                 • Overall mode = schematic (mixed): fall back to
    //                   the legacy four-domain blob so the user still
    //                   sees σ⁷⁰.  TODO: when selective PDB loading
    //                   lands, render only PDB chain F here.
    //
    // All branches are gated by `presence > 0.02` so once σ has
    // departed (presence ≈ 0) nothing is drawn.  liftY is applied
    // uniformly so σ rides with RNAP during approach / detach.
    // ----------------------------------------------------------------
    if (presence > 0.02) {
      if (options.sigma === "mesh") {
        // -- Mesh mode: rigid-body σ on chain M -------------------------
        let prevSigmaSerial: number | null = null;
        for (const sa of SIGMA_ATOMS) {
          // Resolve anchor point (in scene coords, before assemble/release).
          let anchorX = 0, anchorZ = 0;
          if (sa.anchor.kind === "promoter") {
            const idx = safeBackboneIdx(sa.anchor.coord, tssIndex, boneLen);
            anchorZ = backbone[idx].axis[2];
          } else {
            // Anchored on RNAP body (σ1.1 sits inside the cleft).
            anchorX = rnapCenter[0];
            anchorZ = rnapCenter[2];
          }

          // Bound position = anchor + per-region boundOffset.
          const boundX = anchorX + sa.boundOffset[0];
          const boundY = sa.boundOffset[1];
          const boundZ = anchorZ + sa.boundOffset[2];

          // Pre-assembly = bound + UNIFORM σ-wide approach offset.  Same
          // vector for every region → σ holds its rigid shape during the
          // approach translation, instead of regions drifting together
          // from per-region spread vectors.
          const spreadX = boundX + SIGMA_APPROACH_OFFSET[0];
          const spreadY = boundY + SIGMA_APPROACH_OFFSET[1];
          const spreadZ = boundZ + SIGMA_APPROACH_OFFSET[2];

          // Assembly lerp: spread → bound as assembleFraction goes 0 → 1.
          const assembledX = boundX * assembleFraction + spreadX * (1 - assembleFraction);
          const assembledY = boundY * assembleFraction + spreadY * (1 - assembleFraction);
          const assembledZ = boundZ * assembleFraction + spreadZ * (1 - assembleFraction);

          // Released = bound + UNIFORM σ-wide release offset.  Again the
          // same vector for every region so σ leaves as a rigid body.
          const releasedX = boundX + SIGMA_RELEASE_OFFSET[0];
          const releasedY = boundY + SIGMA_RELEASE_OFFSET[1];
          const releasedZ = boundZ + SIGMA_RELEASE_OFFSET[2];

          // Presence lerp: assembled → released as presence goes 1 → 0.
          const x = assembledX * presence + releasedX * (1 - presence);
          const y = (assembledY * presence + releasedY * (1 - presence)) + liftY;
          const z = assembledZ * presence + releasedZ * (1 - presence);

          const atom: Atom = {
            elem: "C",
            x, y, z,
            resn: "SIG",
            resi: sa.resi,
            chain: "M",
            serial: serial++,
            atomName: `R${sa.region}`,
          };
          if (prevSigmaSerial !== null) {
            atom.bonds = [prevSigmaSerial];
            atom.bondOrder = [1];
          }
          prevSigmaSerial = atom.serial;
          atoms.push(atom);

          if (sa.labelAnchor && sa.label) {
            labels.push({
              id: `sigma:${sa.region}`,
              text: sa.label,
              position: [x, y + 7, z],
              opacity: presence,
            });
          }
        }
      } else {
        // -- "schematic" or "atomic" — emit legacy four-domain blob.
        //
        // For options.sigma === "atomic" while overall mode is mixed,
        // we render the legacy procedural σ as a placeholder until
        // selective PDB loading is implemented (see block-level comment
        // at the top of the σ⁷⁰ section above).  When overall mode is
        // atomic, atomic.ts strips chain S and PDB chain F supplies the
        // cartoon, so this code path is invisible in that case.
        let prevSigmaSerial: number | null = null;
        for (let d = 0; d < LEGACY_SIGMA_DOMAINS.length; d++) {
          const dom = LEGACY_SIGMA_DOMAINS[d];
          const domIdx = safeBackboneIdx(dom.coord, tssIndex, boneLen);
          const axisZ = backbone[domIdx].axis[2];

          // Bound anchor — near the coding face at this promoter coord.
          const boundY = dom.boundOffset[0];
          const boundX = dom.boundOffset[1];

          // Released pose — drifts up and lateral after promoter escape.
          const releasedY = 75 + d * 3;
          const releasedX = 35 + d * 6;

          // Per-domain assembly spread (legacy behaviour preserved).
          const spreadY = dom.assemblySpread[0];
          const spreadX = dom.assemblySpread[1];
          const preAssembleX = boundX + spreadX;
          const preAssembleY = boundY + spreadY;
          const assembledX = boundX * assembleFraction + preAssembleX * (1 - assembleFraction);
          const assembledY = boundY * assembleFraction + preAssembleY * (1 - assembleFraction);

          const x = assembledX * presence + releasedX * (1 - presence);
          const y = (assembledY * presence + releasedY * (1 - presence)) + liftY;
          const z = axisZ;

          const atom: Atom = {
            elem: "C",
            x, y, z,
            resn: "SIG",
            resi: d + 1,
            chain: "S",
            serial: serial++,
            atomName: dom.label.toUpperCase(),
          };
          if (prevSigmaSerial !== null) {
            atom.bonds = [prevSigmaSerial];
            atom.bondOrder = [1];
          }
          prevSigmaSerial = atom.serial;
          atoms.push(atom);
        }
      }
    }

    const viewDistance = Math.max(80, manifest.sequence.sequence_length * 2);

    return {
      atoms,
      labels,
      hints: { rnapCenter, viewDistance, sigma70Presence: presence },
    };
  }
}

export function createSchematicBuilder(): GeometryBuilder {
  return new SchematicBuilder();
}
