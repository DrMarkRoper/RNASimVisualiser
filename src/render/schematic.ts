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

// -------------------------------------------------------------------------
// Bubble geometry (Phase B, revised 2026-05-01 against publications.md R1).
//
// The upstream and downstream duplex segments are now drawn STRAIGHT and
// COLLINEAR (along +Z), matching the Santangelo & Artsimovitch (2011)
// Figure 1 schematic and the Vassylyev 2007 / Kang 2017 cryo-EM
// structures: the global double-helix axis does not kink at the
// elongation complex.  The "90° bend" referred to in the literature is
// a *template-strand sharp turn at the active site*, internal to the
// RNAP body — not a bend in the upstream / downstream duplex.
//
// Inside the bubble the two strands take different paths:
//   • Coding (non-template) strand bulges *upward* over the β′-clamp
//     (β′ at +Y in this orientation — see RNAP_SUBUNITS below).  This is
//     the strand "exposed on the surface" in the Figure 1 caption.
//   • Template strand dips *downward* into the active-site cleft (toward
//     β at −Y).  The template's sharp turn at the active site is the
//     literature's 90° template bend; in the schematic we approximate it
//     by giving the template a small inward Y dip rather than rendering
//     two explicit 90° vertices.
//
// During scrunching the bubble's *physical Z extent* stays constant
// (held by RNAP) while bubble_size grows — this packs more bases into
// the same Z range, so each base's spacing along the bubble shrinks.
// Compression emerges naturally from the
// `t = (i − bubbleLoIdx) / bubble_size` parameterisation.
//
// Numerical constants are documented in `docs/dna_path_geometry.md`,
// with bibliography entries in `publications.md`.
// -------------------------------------------------------------------------

const CODING_WRAP_OFFSET = 22;       // Å — upward bulge of coding strand at bubble midpoint
const TEMPLATE_DIP_OFFSET = 6;       // Å — downward dip of template strand at bubble midpoint
const RNA_EXIT_Y_OFFSET = 28;        // Å — RNA exit anchor lift above DNA axis
const RNA_EXIT_X_OFFSET = -5;        // Å — RNA exit anchor pulled back from rnapCenter
// Physical Z extent of the open-complex bubble — held roughly constant
// by RNAP body geometry.  At standard B-helix rise (3.4 Å/bp) this fits
// 13 bp at natural spacing; during scrunching the same extent holds 18+
// bp, so each base spacing decreases (the renderer's scrunching effect).
const BUBBLE_PHYSICAL_WIDTH = 13 * RISE_PER_BP;

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
  idx: number;                       // 0-based index along coding_strand
  coord: number;                     // TSS-relative position (+1, +2, ..., never 0)
  axis: [number, number, number];    // helix axis position (now bent through the bubble)
  twist: number;                     // rotation angle around axis (B-helix twist)
  /** Tangent unit vector — points along the path in the 5′→3′ direction. */
  tangent: [number, number, number];
  /** Radial unit vector — perpendicular to the tangent, in the bend plane,
   *  pointing *outward* from the bend centre.  This is the direction the
   *  coding strand bulges when it wraps over the RNAP body. */
  radial: [number, number, number];
  /** True if base i is inside the bubble (strands separated). */
  melted: boolean;
}

/**
 * Helix-axis path under the straight-duplex / template-bend-inside-RNAP
 * model (revised 2026-05-01 against publications.md R1, R2, R3).
 *
 * Both upstream and downstream duplex segments lie on the same straight
 * +Z axis at Y = 0.  No global bend in the helix axis.
 *
 * Inside the bubble the strands take different paths via `strandPosition`:
 *   • coding strand bulges +Y over the β′-clamp (exposed surface);
 *   • template strand dips −Y into the active-site cleft (the "template
 *     sharp turn" at the active site is approximated as a Y dip rather
 *     than two explicit 90° vertices, which would be much more code for
 *     an effectively-equivalent visual).
 *
 * Scrunching: bubble Z extent is held at BUBBLE_PHYSICAL_WIDTH regardless
 * of bubble size, so as `bubble_size` grows the per-base spacing along
 * the bubble shrinks.  Bubble Z range is anchored at the bubble's
 * upstream edge (held by σ⁷⁰ during scrunching, slides with the bubble
 * during elongation), so the upstream duplex stays stationary frame-to-
 * frame and the downstream duplex slides only with `bubble_upstream` (no
 * dependence on `snapshot.position`).
 */
function computeBackbone(
  manifest: SimulationManifest,
  snapshot: Snapshot,
): BaseAxisPoint[] {
  const len = manifest.sequence.sequence_length;
  const tssIndex = manifest.sequence.tss_index;

  // Bubble bounds (clamped).
  const bubbleLoIdx = safeBackboneIdx(snapshot.bubble_upstream,   tssIndex, len);
  const bubbleHiIdx = safeBackboneIdx(snapshot.bubble_downstream, tssIndex, len);
  const bubbleSize  = Math.max(1, bubbleHiIdx - bubbleLoIdx);

  // Same bubble-active gate as the previous bent model:
  //   • approaching → bubble_upstream == bubble_downstream (no bubble)
  //   • detaching   → engine animates bubble closed; we treat the entire
  //                   detach as "no bubble" so the duplex doesn't squirm
  //                   as bases trickle out frame-by-frame
  //   • elsewhere   → real bubble
  const hasBubble =
    bubbleHiIdx > bubbleLoIdx && snapshot.phase !== "detaching";

  // Z-coordinate of the bubble's upstream edge — anchors the bubble in
  // scene coordinates.  Stationary during scrunching (σ holds
  // bubble_upstream pinned at −11), slides with bubble_upstream during
  // elongation.  Upstream duplex bases at i < bubbleLoIdx have axis Z
  // that depends on i alone, so they're frame-stationary.
  const bubbleStartZ = (bubbleLoIdx - tssIndex) * RISE_PER_BP;
  // Physical bubble end: a fixed Z offset downstream of the start.  This
  // is what implements scrunching — bubbleEndZ doesn't depend on
  // bubble_size, only on bubble_upstream, so as the engine adds bases to
  // the bubble during initiation they pack into the same Z extent.
  const bubbleEndZ = bubbleStartZ + BUBBLE_PHYSICAL_WIDTH;

  const out: BaseAxisPoint[] = [];
  for (let i = 0; i < len; i++) {
    const delta = i - tssIndex;
    const coord = delta < 0 ? delta : delta + 1;
    const twist = i * TWIST_PER_BP;

    let axis: [number, number, number];
    const tangent: [number, number, number] = [0, 0, 1];
    const radial:  [number, number, number] = [0, 1, 0];
    let melted = false;

    if (!hasBubble) {
      // No bubble → straight B-helix everywhere, axis Y = 0.
      const z = (i - tssIndex) * RISE_PER_BP;
      axis = [0, 0, z];
    } else if (i < bubbleLoIdx) {
      // Upstream of bubble — stationary helix axis at Y = 0.
      const z = (i - tssIndex) * RISE_PER_BP;
      axis = [0, 0, z];
    } else if (i > bubbleHiIdx) {
      // Downstream of bubble — straight along +Z, anchored at bubbleEndZ.
      // Downstream duplex bases shift slightly in Z as bubble_upstream
      // moves (i.e. the engine reels DNA into the body during scrunching
      // and elongation), but they stay co-linear with the upstream
      // duplex, so the entire visible scene reads as a single straight
      // double-helix that has a "bubble" opened in the middle of it.
      const offset = (i - bubbleHiIdx) * RISE_PER_BP;
      axis = [0, 0, bubbleEndZ + offset];
    } else {
      // Inside bubble — bases packed along Z from bubbleStartZ to
      // bubbleEndZ, with strand-specific Y excursions added by
      // strandPosition (coding +Y bulge, template −Y dip).
      melted = true;
      const t = (i - bubbleLoIdx) / bubbleSize;
      const z = bubbleStartZ + t * (bubbleEndZ - bubbleStartZ);
      axis = [0, 0, z];
    }

    out.push({ idx: i, coord, axis, twist, tangent, radial, melted });
  }
  return out;
}

/**
 * Strand position for a backbone point.
 *
 * Outside the bubble (paired duplex): standard B-helix wrap in the
 * (X, Y) plane around the +Z axis.
 *
 * Inside the bubble (separated strands):
 *   • Coding strand  (+1): arcs *upward* — Y peaks at
 *       +CODING_WRAP_OFFSET (= 22 Å) at the bubble midpoint.  This is
 *       the strand "exposed on the surface" of RNAP, wrapping over the
 *       β′-clamp at y = +22 (see RNAP_SUBUNITS — β′ now sits on top
 *       per Santangelo 2011 Fig 1, publications.md R1).
 *   • Template strand (−1): dips *downward* — Y trough at
 *       −TEMPLATE_DIP_OFFSET (= −6 Å), threading through the active-
 *       site cleft toward β at y = −22.  The literature's "template
 *       90° turn at the active site" is approximated by this Y dip
 *       rather than rendered as two explicit 90° vertices.
 *
 *   Both excursions are gated by a sin(π · t) envelope so the strands
 *   re-anneal smoothly to the upstream / downstream B-helix at the
 *   bubble boundaries.
 */
function strandPosition(
  pt: BaseAxisPoint,
  strandSign: 1 | -1,
  bubbleLoIdx: number,
  bubbleHiIdx: number,
): [number, number, number] {
  const [ax, ay, az] = pt.axis;
  const phase = strandSign === 1 ? pt.twist : pt.twist + Math.PI;

  if (!pt.melted) {
    // Paired duplex — standard B-helix wrap in (X, Y) around the axis.
    return [
      ax + HELIX_RADIUS * Math.cos(phase),
      ay + HELIX_RADIUS * Math.sin(phase),
      az,
    ];
  }

  // Inside bubble — strands separate.
  const bubbleSize = Math.max(1, bubbleHiIdx - bubbleLoIdx);
  const t = (pt.idx - bubbleLoIdx) / bubbleSize;
  const env = Math.sin(Math.PI * t); // 0 at boundaries, 1 in middle

  // Twist contribution fades to zero in the middle of the bubble (strands
  // are no longer base-paired there) and recovers at the boundaries.
  const helixR = HELIX_RADIUS * (1 - env);

  if (strandSign === 1) {
    // Coding (non-template) — arcs upward over the β′-clamp.
    return [
      ax + helixR * Math.cos(phase),
      ay + helixR * Math.sin(phase) + CODING_WRAP_OFFSET * env,
      az,
    ];
  } else {
    // Template — dips downward into the active-site cleft.
    return [
      ax + helixR * Math.cos(phase),
      ay + helixR * Math.sin(phase) - TEMPLATE_DIP_OFFSET * env,
      az,
    ];
  }
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
  // α dimer — assembly platform on the BACK of the body (opposite the
  // cleft).  Two copies of the same protein, placed symmetrically along
  // Z so they read as a dimer.  Light / cool grey pushes them visually
  // backward in the depth dimension.  Source: Murakami 2015
  // (publications.md R5) — α-NTDs scaffold complex assembly, sit
  // opposite the active-site cleft.
  { chain: "Y", resi: 1, label: "α I",  offset: [-12, -3, -12], radius: 7,  color: "#cbd5e1" },
  { chain: "Z", resi: 1, label: "α II", offset: [-12, -3,  12], radius: 7,  color: "#94a3b8" },

  // β′ subunit — UPPER jaw of the cleft.  Contains the clamp (closes
  // over downstream DNA), the bridge helix, and the Mg²⁺ active site.
  // The non-template (coding) strand wraps OVER this subunit on the
  // surface of the body — the renderer's coding-strand +Y bulge lands
  // directly over β′.  Source: Santangelo & Artsimovitch 2011 Fig 1
  // (publications.md R1) — "RNA exit channel formed between β-flap and
  // β′-clamp".  Note positions swapped 2026-05-01: pre-swap had β on
  // top.  Drawn slightly larger / darker than β so the active-site half
  // reads as the "business end".
  { chain: "K", resi: 1, label: "β'",   offset: [  0, 22,   0], radius: 16, color: "#475569" },

  // β subunit — LOWER jaw of the cleft (lobe + protrusion + flap).  The
  // β-flap caps the upper edge of the RNA exit channel from below.  The
  // template strand dips down toward this side at the active site.
  { chain: "Q", resi: 1, label: "β",    offset: [  0,-22,   0], radius: 15, color: "#64748b" },

  // ω subunit — small β′-folding chaperone, repositioned to sit
  // ADJACENT TO β′ (NOT next to the α-dimer).  Source: Murakami 2015
  // (publications.md R5) — ω wraps the C-terminal region of β′ and is
  // structurally a β′-side accessory.  Tucked just behind / below β′ so
  // it doesn't visually merge with the β′ sphere.
  { chain: "O", resi: 1, label: "ω",    offset: [-12, 16,   0], radius: 4,  color: "#1e293b" },
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
    const backbone = computeBackbone(manifest, snapshot);
    const atoms: Atom[] = [];
    let serial = 1;

    const tssIndex = manifest.sequence.tss_index;
    const boneLen  = backbone.length;
    const bubbleLoIdx = safeBackboneIdx(snapshot.bubble_upstream,   tssIndex, boneLen);
    const bubbleHiIdx = safeBackboneIdx(snapshot.bubble_downstream, tssIndex, boneLen);

    const coding   = manifest.sequence.coding_strand;
    const template = manifest.sequence.template_strand;

    // σ⁷⁰ presence — monotonic function of simulation time.
    const presence = getSigma70Presence(manifest, snapshot);

    // Animation fractions for "approaching" and "detaching" phases.
    const { liftFactor, assembleFraction, detachFraction } = computeAnimationFractions(manifest, snapshot);
    const liftY = LIFT_HEIGHT_ANG * liftFactor;

    // RNAP body anchor — at the centre of the DNA bend.  Z-coordinate
    // matches the bend centre derived in computeBackbone: the bend is
    // anchored at the bubble's upstream edge (which is held by σ⁷⁰ during
    // initiation and slides with the bubble during elongation).  Pinning
    // off bubble_upstream rather than `position` is what gives scrunching
    // its biology — the upstream edge stays put while extra bases pile in,
    // so the bend (and rnapCenter) doesn't move during scrunching frames.
    const rnapAxisZ = (bubbleLoIdx - tssIndex) * RISE_PER_BP;
    const rnapCenter: [number, number, number] = [0, liftY, rnapAxisZ];

    // ----------------------------------------------------------------
    // DNA strands (chains A and B)
    //
    // Each strand walks the full backbone.  Inside the bubble the two
    // strands take *different* paths (coding wraps over the body,
    // template threads through the cleft) — see strandPosition().
    //
    // DNA does NOT receive the liftY offset.  liftY is the
    // approach/detach RNAP lift — it should make RNAP appear to descend
    // toward / lift off the DNA, not move the DNA itself.  Earlier
    // versions added liftY to the DNA strand atoms too, which made the
    // entire complex (DNA + RNAP) rise together — visually wrong, since
    // genomic DNA stays put while RNAP moves.
    // ----------------------------------------------------------------

    let prevA: number | null = null;
    for (const pt of backbone) {
      const [x0, y0, z0] = strandPosition(pt, +1, bubbleLoIdx, bubbleHiIdx);
      const atom: Atom = {
        elem: "P",
        x: x0, y: y0, z: z0,
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
      const [x0, y0, z0] = strandPosition(pt, -1, bubbleLoIdx, bubbleHiIdx);
      const atom: Atom = {
        elem: "P",
        x: x0, y: y0, z: z0,
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
    //
    // Anchored on the helix axis at TSS-relative coord −11 (the upstream
    // edge of the bubble — biologically W433 wedges between bp −11/−12).
    // In the new bent geometry this is the bend's upstream entry point,
    // which sits at rnapCenter (z = rnapAxisZ).  The retracted ↔ inserted
    // animation moves the indole *along the radial axis* of the helix at
    // that point — outward (away from RNAP cleft) when retracted, inward
    // (into the major groove) when inserted.  Released pose drifts up and
    // outward as σ⁷⁰ leaves.
    // ----------------------------------------------------------------
    if (presence > 0.02) {
      const w433TargetCoord = -11;
      const w433Idx = safeBackboneIdx(w433TargetCoord, tssIndex, boneLen);
      const w433Pt = backbone[w433Idx];
      const [ax, ay, az] = w433Pt.axis;
      const [rx, ry, rz] = w433Pt.radial;
      const depth = snapshot.w433_depth;

      // Distance along the local radial direction.  retracted = 25 Å out
      // (clear of the duplex), inserted = HELIX_RADIUS * 0.6 (just inside
      // the major-groove edge).  Same numbers as the pre-bend version.
      const retractedR = 25;
      const insertedR  = HELIX_RADIUS * 0.6;
      const r = retractedR * (1 - depth) + insertedR * depth;

      const boundX = ax + r * rx;
      const boundY = ay + r * ry;
      const boundZ = az + r * rz;

      // Released pose — drift up and outward, in scene coords (axis-relative
      // would still slide with rnapCenter, which we don't want for "leaving
      // the holoenzyme").
      const releasedCenter: [number, number, number] = [38, 68, az];

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
    // channel, so the *entire* nascent RNA — both the hybrid window and any
    // 5′ excess — stays inside the RNAP body.  Real biology: σ1.1 occludes
    // both the main channel and the RNA exit channel; RNA accumulates inside
    // until it scrunches enough to displace σ1.1 (this strain is one of the
    // forces driving promoter escape).  The "RNA exit thread" must NOT show
    // until σ⁷⁰ has begun to release.
    //
    // Chain T — "trapped" bases (everything inside RNAP while σ is bound):
    //   • Rendered for the *full* RNA length whenever σ is present
    //     (`presence > 0.05`).  Hybrid window AND 5′ excess both go here —
    //     no part of the transcript exits the body until σ leaves.
    //   • Drawn as a tight cluster coiled near the RNAP body interior,
    //     coloured amber to signal they cannot exit.
    //
    // Chain R — exit-channel thread (only after σ has released):
    //   • Renders only when σ is absent (`presence ≤ 0.05`).
    //   • The 5′ end emerges from the exit channel (anchor offset above and
    //     upstream of rnapCenter) running −Z, parallel to upstream DNA.
    //
    // The threshold matches `sigmaPresent` so the visual switch is single-
    // valued: as σ presence falls past 0.05 the trapped coil disappears and
    // the exit thread appears in the same frame.  At normal frame cadence
    // this transition reads as "σ leaves → RNA spools out".
    // ----------------------------------------------------------------
    const rna = snapshot.rna_sequence;
    const sigmaPresent = presence > 0.05;
    const armLen = 4 * rna.length;

    // RNA exit anchor.  Post-Phase-B the RNA exit channel runs roughly
    // *parallel to the upstream DNA*, exiting from the upstream face of
    // RNAP (the back of the holoenzyme).  Walking the arm out from the
    // anchor moves UPSTREAM (−Z) — anti-parallel to the upstream DNA's
    // 5′→3′ tangent (+Z) — so the RNA visibly emerges going "back the
    // way the DNA came in", not in the downstream direction.
    //
    // The anchor itself sits offset from rnapCenter by:
    //   • +Y by RNA_EXIT_Y_OFFSET so the arm clears the upstream DNA
    //     duplex (which sits on the helix axis at y = 0);
    //   • −X by RNA_EXIT_X_OFFSET to peel the arm slightly away from the
    //     downstream DNA / β′ clamp area.
    //
    // During "detaching" the RNA decouples from RNAP and drifts away
    // along −X (perpendicular to the lift direction), so the trajectory
    // visibly diverges from the rising RNAP body — see the biology note
    // about hairpin-driven release in the chain-T comment block above.
    const rnaAnchorBound: [number, number, number] = [
      rnapCenter[0] + RNA_EXIT_X_OFFSET,
      rnapCenter[1] + RNA_EXIT_Y_OFFSET,
      rnapCenter[2],
    ];
    const RNA_DRIFT_X = 50; // Å total lateral drift of released transcript
    // During detaching the RNA decouples from RNAP — RNAP rises in +Y,
    // RNA drifts outward in −X.  Crucially we do NOT zero the RNA's Y
    // (the previous code did, which dropped the entire transcript by
    // RNA_EXIT_Y_OFFSET = 28 Å the moment "detaching" started).  We
    // instead hold the RNA at the same exit-channel Y it had at the
    // moment of release (RNA_EXIT_Y_OFFSET above the un-lifted helix
    // axis), so the RNA stays put while RNAP visibly lifts off above it.
    const rnaAnchor: [number, number, number] =
      snapshot.phase === "detaching"
        ? [
            rnaAnchorBound[0] - RNA_DRIFT_X * detachFraction,
            RNA_EXIT_Y_OFFSET, // un-lifted Y; decouples from rnapCenter[1]'s liftY
            rnaAnchorBound[2],
          ]
        : rnaAnchorBound;

    // Chain T plays a dual role:
    //
    //   σ bound (sigmaPresent = true):
    //     The full nascent transcript is trapped inside RNAP — σ1.1
    //     occludes the exit channel, so even bases beyond the 9-nt
    //     hybrid can't get out.  Render as a tight coil at rnapCenter.
    //
    //   σ released (sigmaPresent = false):
    //     Only the 3′-end *hybrid window* (last HYBRID_LEN_SCHEMATIC bases
    //     paired with template) sits inside the body — these are at the
    //     active site, base-paired with the template strand.  The 5′ tail
    //     (anything beyond the hybrid) is on chain R, threading through
    //     the exit channel.  Rendering the hybrid in chain T with its
    //     existing amber colour matches the SequencePanel's `rna-hybrid`
    //     yellow highlight (publications.md R1: "8–9 bp of the RNA–DNA
    //     hybrid, the key determinant of elongation complex stability").
    //
    // Hybrid bases are placed at the template-strand positions inside the
    // bubble (the last HYBRID_LEN_SCHEMATIC bubble bases on the template
    // path), with a small +Y offset so they don't co-render with the
    // template spheres.  This puts the hybrid right at the active-site
    // end of the bubble where it biologically lives.
    const hybridLen = Math.min(rna.length, HYBRID_LEN_SCHEMATIC);
    if (sigmaPresent && rna.length > 0) {
      // -- σ bound: full RNA coiled inside RNAP --------------------------
      let prevT: number | null = null;
      for (let k = 0; k < rna.length; k++) {
        const base = rna[k];
        const turns = Math.min(2, rna.length / 9);
        const angle = (k / Math.max(rna.length, 1)) * turns * 2 * Math.PI;
        const coilR = 8;
        const zSpan = Math.min(12, rna.length * 0.6);
        const x = rnapCenter[0] + coilR * Math.cos(angle);
        const y = rnapCenter[1] + coilR * Math.sin(angle);
        const z = rnapCenter[2] - zSpan / 2 + (k / Math.max(rna.length - 1, 1)) * zSpan;
        const atom: Atom = {
          elem: "O",
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
    } else if (!sigmaPresent && hybridLen > 0) {
      // -- σ released: hybrid bases inside bubble at template positions --
      let prevT: number | null = null;
      // The hybrid is at the 3′ end of the RNA, base-paired with the
      // template at the downstream (active-site) end of the bubble.  In
      // the bubble parameterisation, that's the last `hybridLen` bubble
      // bases — i.e. backbone indices [bubbleHiIdx − hybridLen + 1 ..
      // bubbleHiIdx].  We sample the template path at those indices and
      // offset slightly in +Y so the hybrid spheres sit just above the
      // template line (visible without overlapping it).
      for (let k = rna.length - hybridLen; k < rna.length; k++) {
        const base = rna[k];
        // Map RNA index k onto the corresponding bubble position.  Active
        // site = downstream bubble edge; the last RNA base k = rna.length−1
        // sits at the active site (bubbleHiIdx).  So:
        const offsetFrom3 = (rna.length - 1) - k;     // 0 for 3′-most base
        const tmplIdx = bubbleHiIdx - offsetFrom3;
        const tmplPt =
          tmplIdx >= 0 && tmplIdx < backbone.length
            ? backbone[tmplIdx]
            : backbone[bubbleHiIdx];
        const [tx, ty, tz] = strandPosition(tmplPt, -1, bubbleLoIdx, bubbleHiIdx);
        const atom: Atom = {
          elem: "O",
          x: tx,
          y: ty + 4,         // small +Y lift so hybrid is visible above template
          z: tz,
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

    // Chain R — exiting RNA, only after σ has released.  Renders the 5′
    // tail beyond the hybrid window (bases 0 .. rna.length − hybridLen − 1).
    // When σ is released and rna.length ≤ HYBRID_LEN_SCHEMATIC, all bases
    // are in the hybrid → chain R renders nothing (correct: nothing has
    // exited yet).
    if (!sigmaPresent && rna.length > hybridLen) {
      const tailLen = rna.length - hybridLen;
      let prevR: number | null = null;
      for (let k = 0; k < tailLen; k++) {
        const base = rna[k];
        const t = k / Math.max(tailLen - 1, 1);
        const x = rnaAnchor[0] + Math.sin(t * Math.PI) * 4;
        const y = rnaAnchor[1] + Math.sin(t * Math.PI) * 10;
        const z = rnaAnchor[2] - t * armLen - 5;
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
          // Promoter-coord anchors (σ4 at −35, σ3 at −22, σ2 at −10) sit
          // on the *upstream straight* DNA section after the bend rewrite,
          // so axis[1] (Y) = 0 and we only need the per-coord X / Z.
          // RNAP-anchored atoms (σ1.1) ride with rnapCenter.
          let anchorX = 0, anchorY = 0, anchorZ = 0;
          if (sa.anchor.kind === "promoter") {
            const idx = safeBackboneIdx(sa.anchor.coord, tssIndex, boneLen);
            const a = backbone[idx].axis;
            anchorX = a[0];
            anchorY = a[1];
            anchorZ = a[2];
          } else {
            anchorX = rnapCenter[0];
            anchorY = 0; // rnapCenter Y is liftY; liftY is added uniformly below
            anchorZ = rnapCenter[2];
          }

          // Bound position = anchor + per-region boundOffset.
          const boundX = anchorX + sa.boundOffset[0];
          const boundY = anchorY + sa.boundOffset[1];
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
          // Anchor on the full helix-axis position at the promoter coord —
          // post-Phase-B this is on the upstream straight section so X = 0
          // and Y = 0, but we read all three components for forward-compat
          // (e.g. if the bend ever extends past −10).
          const anchor = backbone[domIdx].axis;

          // Bound anchor — near the coding face at this promoter coord.
          const boundY = dom.boundOffset[0];
          const boundX = anchor[0] + dom.boundOffset[1];

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
          const z = anchor[2];

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
