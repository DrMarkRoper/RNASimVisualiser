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
/** Re-export for atomic.ts so the atomic-mode template-strand C1'
 *  override + 3' phantom-residue extrapolation can use the same
 *  helix parameters the schematic builds. */
export const SCHEMATIC_HELIX_RADIUS = HELIX_RADIUS;
export const SCHEMATIC_RISE_PER_BP  = RISE_PER_BP;
export const SCHEMATIC_TWIST_PER_BP = TWIST_PER_BP;

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
// RNA exit channel — emerges between β (bottom of cleft, y = −22) and the
// α-dimer (back of body, y ≈ −3, x ≈ −12), running toward the rear of the
// holoenzyme.  The user's reading of Santangelo 2011 Fig 1 places the
// channel on the β / α side of RNAP, NOT above β′ as the previous
// (+Y = +28) anchor did.  After the β/β′ swap (β′ now on top, β on
// bottom), the +Y side is the β′-clamp — wrong for the exit.  New anchor:
// pulled back in −X (toward α-dimer) and slightly below centre in −Y so
// the arm exits through the gap between β and α.
const RNA_EXIT_X_OFFSET = -12;       // Å — RNA exit anchor at α-side back face
const RNA_EXIT_Y_OFFSET = -10;       // Å — between β (y=-22) and α (y≈-3), ~midway
// Physical Z extent of the open-complex bubble — held roughly constant
// by RNAP body geometry.  At standard B-helix rise (3.4 Å/bp) this fits
// 13 bp at natural spacing; during scrunching the same extent holds 18+
// bp, so each base spacing decreases (the renderer's scrunching effect).
const BUBBLE_PHYSICAL_WIDTH = 13 * RISE_PER_BP;

// -------------------------------------------------------------------------
// Intrinsic-terminator hairpin geometry (added 2026-05-02).
//
// During the new `hairpin_forming` phase (snapshot.py::Phase) the engine
// emits a fixed number of frames in which RNA shape changes but the
// engine state does not — the renderer interpolates each RNA base from
// its pre-fold "home" position toward a precomputed hairpin target.
//
// Target geometry follows publications.md R10 (You et al. 2023): the
// hairpin folds in the exit channel with the loop apex pointing away
// from RNAP and the hairpin axis approximately parallel to the upstream
// duplex.  The local frame is anchored on the existing exit channel
// (RNA_EXIT_X_OFFSET / RNA_EXIT_Y_OFFSET) and oriented so +ẑ_loc is the
// chain-R arm direction the renderer already uses, +ŷ_loc is
// perpendicular to ẑ_loc and to the upstream DNA tangent (the hairpin
// opens away from the DNA), and +x̂_loc completes the right-handed
// frame.  No new exit anchor — the user's "RNA somewhat away from the
// DNA" requirement is already satisfied by the existing 45° arm.
// -------------------------------------------------------------------------

const HAIRPIN_STEM_RNA_RISE_A   = 3.3;   // Å — single-strand RNA spacing within a stem arm
const HAIRPIN_STEM_INTERARM_A   = 9.0;   // Å — stem-pair backbone–backbone separation
const HAIRPIN_OPACITY_FLOOR     = 0.4;   // chain-H opacity when fold weight is 0
const HAIRPIN_NUC_DIST_COEFF    = 0.4;   // weight-shift coefficient — loop folds first
// Perpendicular offset for the 5′ tail when the hairpin has formed.
// The chain-R STEP direction is collinear with the hairpin's +ẑ_loc
// axis (the stem5 arm direction by construction), so without an
// offset the 5′ tail bases land exactly on top of the stem5 arm
// bases.  Offsetting one nt-spacing in +x̂_loc (perpendicular to the
// hairpin plane) separates the tail from the stem5 arm so the
// upstream RNA is visible alongside the folded hairpin.  Offset
// scales with the fold fraction F so the transition is continuous
// from pre-fold (no offset, tail walks straight back) to fully
// formed (~3.3 Å perpendicular separation).
const HAIRPIN_TAIL_PERP_OFFSET  = 3.3;   // Å — perpendicular displacement at F = 1

// Step components used both by the existing chain-R arm and by the
// hairpin local-frame ẑ axis (so the fold direction matches the exit
// arm direction the user already sees).
const RNA_EXIT_STEP_X = -1.6;
const RNA_EXIT_STEP_Y = -1.6;
const RNA_EXIT_STEP_Z = -2.4;

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
  /** Per-strand 5'→3' tangent in scene coordinates, used by the atomic-mode
   *  renderer to orient each residue's atom template along the actual
   *  strand path.  Outside the bubble both strands lie on a straight +Z
   *  helix so both tangents = +Z (coding) and -Z (template, antiparallel).
   *  Inside the bubble the coding strand arcs +Y and the template dips -Y;
   *  these tangents are then finite-differenced from the per-base
   *  strandPosition() output so the residue atoms follow the bulge / dip.
   *  Schematic mode ignores these fields (one-sphere-per-base doesn't
   *  need a tangent). */
  strandTangentCoding:   [number, number, number];
  strandTangentTemplate: [number, number, number];
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
  _snapshot: Snapshot,
  bubbleLoIdx: number,
  bubbleHiIdx: number,
): BaseAxisPoint[] {
  const len = manifest.sequence.sequence_length;
  const tssIndex = manifest.sequence.tss_index;

  // Bubble bounds passed in by build() — they may be the engine's raw
  // bounds, or an artificially-shrunk version during the early-detach
  // collapse animation (see computeEffectiveBubble in build).
  const bubbleSize  = Math.max(1, bubbleHiIdx - bubbleLoIdx);
  const hasBubble = bubbleHiIdx > bubbleLoIdx;

  // Z-coordinate of the bubble's upstream edge — anchors the bubble in
  // scene coordinates.  Stationary during scrunching (σ holds
  // bubble_upstream pinned at −11), slides with bubble_upstream during
  // elongation.  Upstream duplex bases at i < bubbleLoIdx have axis Z
  // that depends on i alone, so they're frame-stationary.
  const bubbleStartZ = (bubbleLoIdx - tssIndex) * RISE_PER_BP;
  // Physical bubble end: anchored to the downstream bubble edge at its
  // natural B-helix position.  Using bubbleSize * RISE_PER_BP (rather
  // than the fixed BUBBLE_PHYSICAL_WIDTH) keeps downstream bases at
  // their natural positions at all times — critical during the detach
  // bubble-collapse where bubbleHiIdx shrinks while bubbleLoIdx (and
  // thus bubbleStartZ) stays fixed.  During normal elongation
  // bubbleSize = 13 so bubbleSize * RISE_PER_BP = BUBBLE_PHYSICAL_WIDTH
  // exactly, meaning this is a no-op change for those frames.
  // During scrunching (bubbleSize > 13) the bubble is now allowed to
  // grow physically rather than compressing bases into a fixed extent —
  // more physically accurate (the transcription bubble genuinely grows
  // during open-complex formation).
  const bubbleEndZ = bubbleStartZ + bubbleSize * RISE_PER_BP;

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

    out.push({
      idx: i, coord, axis, twist, tangent, radial,
      // Default tangents — both strands lie on +Z (coding) / -Z (template,
      // antiparallel) outside the bubble.  Inside the bubble we'll
      // overwrite these with finite-differenced strand-position tangents
      // in the second pass below.
      strandTangentCoding:   [0, 0, 1],
      strandTangentTemplate: [0, 0, -1],
      melted,
    });
  }

  // Second pass: finite-difference the strand position to compute
  // per-strand tangents inside the bubble.  Outside the bubble the
  // strands are on the straight helix and the +Z / -Z defaults are
  // exact, so we only patch the bubble interior.  Atomic mode reads
  // these to orient each residue's atom template along the actual
  // strand path; schematic mode ignores them.
  if (out.length >= 2) {
    for (let i = 0; i < out.length; i++) {
      const pt = out[i];
      if (!pt.melted) continue;
      // Use central difference where possible; fall back to one-sided
      // at the bubble boundary.  strandPosition is pure (no side
      // effects) so we can call it three times here cheaply.
      const before = out[Math.max(0, i - 1)];
      const after  = out[Math.min(out.length - 1, i + 1)];
      // Coding tangent.
      const pBeforeC = strandPosition(before, +1, bubbleLoIdx, bubbleHiIdx);
      const pAfterC  = strandPosition(after,  +1, bubbleLoIdx, bubbleHiIdx);
      pt.strandTangentCoding = unitVec([
        pAfterC[0] - pBeforeC[0],
        pAfterC[1] - pBeforeC[1],
        pAfterC[2] - pBeforeC[2],
      ]);
      // Template tangent — finite-diff the template path then NEGATE
      // (template runs antiparallel to coding, so its 5'→3' tangent
      // points opposite the index-increasing direction).
      const pBeforeT = strandPosition(before, -1, bubbleLoIdx, bubbleHiIdx);
      const pAfterT  = strandPosition(after,  -1, bubbleLoIdx, bubbleHiIdx);
      const tplFD = unitVec([
        pAfterT[0] - pBeforeT[0],
        pAfterT[1] - pBeforeT[1],
        pAfterT[2] - pBeforeT[2],
      ]);
      pt.strandTangentTemplate = [-tplFD[0], -tplFD[1], -tplFD[2]];
    }
  }
  return out;
}

/** Normalise a 3-vector; returns a zero vector if input is degenerate. */
function unitVec(v: [number, number, number]): [number, number, number] {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m > 1e-9 ? [v[0] / m, v[1] / m, v[2] / m] : [0, 0, 1];
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
  const phase = strandSign === 1 ? pt.twist : pt.twist - TWIST_PER_BP + Math.PI;

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
  hairpin:  PhaseRange | null;
  detach:   PhaseRange | null;
}

const phaseRangesCache = new WeakMap<SimulationManifest, PhaseRanges>();

function getPhaseRanges(manifest: SimulationManifest): PhaseRanges {
  const cached = phaseRangesCache.get(manifest);
  if (cached) return cached;

  let apStart = -1, apEnd = -1;
  let hpStart = -1, hpEnd = -1;
  let dtStart = -1, dtEnd = -1;

  for (const s of manifest.snapshots) {
    if (s.phase === "approaching") {
      if (apStart < 0) apStart = s.frame;
      apEnd = s.frame;
    }
    if (s.phase === "hairpin_forming") {
      if (hpStart < 0) hpStart = s.frame;
      hpEnd = s.frame;
    }
    if (s.phase === "detaching") {
      if (dtStart < 0) dtStart = s.frame;
      dtEnd = s.frame;
    }
  }

  const result: PhaseRanges = {
    approach: apStart >= 0 ? { start: apStart, end: apEnd } : null,
    hairpin:  hpStart >= 0 ? { start: hpStart, end: hpEnd } : null,
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
  /** Residue index within the chain — used for hover-label disambiguation
   *  AND for label-id uniqueness when multiple atoms share a chain (e.g.
   *  the two-sphere β / β′ extensions). */
  resi: number;
  /** Short on-canvas label (kept compact: "α I", "β'", …).  null = atom is
   *  part of a multi-sphere subunit but doesn't get its own canvas label
   *  (avoids label clutter — only one label per logical subunit). */
  label: string | null;
  /** Centre offset relative to rnapCenter, in Å. */
  offset: [number, number, number];
  /** Sphere radius in Å (used both for styling and label-anchor placement). */
  radius: number;
  /** Hex colour for the sphere (mirrored in styles.ts). */
  color: string;
}

// rnapCenter sits at the active site (~bubble downstream end), so the body
// must extend UPSTREAM to envelop the bubble (which spans
// ~BUBBLE_PHYSICAL_WIDTH = 44.2 Å upstream of the active site).  Each large
// subunit is rendered as TWO spheres, the downstream one centred near
// rnapCenter and the upstream one ~25 Å back — together they form an
// elongated body that covers the bubble extent without using ellipsoids
// (3Dmol's atom geometry is sphere-only).
const RNAP_SUBUNITS: SubunitDef[] = [
  // α dimer — assembly platform on the BACK of the body, pushed UPSTREAM
  // so it sits behind the upstream half of the bubble (the side the
  // hybrid emerges from on its way to the exit channel).  Two copies of
  // the same protein, placed along Z so they read as a dimer.  Source:
  // Murakami 2015 (publications.md R5) — α-NTDs scaffold complex assembly
  // opposite the active-site cleft.
  { chain: "Y", resi: 1, label: "α I",  offset: [-12, -3, -28], radius: 7,  color: "#cbd5e1" },
  { chain: "Z", resi: 1, label: "α II", offset: [-12, -3, -14], radius: 7,  color: "#94a3b8" },

  // β′ subunit — UPPER jaw of the cleft (clamp + bridge helix + active
  // site).  Two spheres: downstream half at rnapCenter, upstream half
  // back ~25 Å so the body envelopes the bubble.  Label on the upstream
  // sphere (closer to the visual centroid of the elongated subunit).
  // Source: Santangelo & Artsimovitch 2011 Fig 1 (publications.md R1) —
  // "RNA exit channel formed between β-flap and β′-clamp"; the coding
  // strand wraps over this surface.
  { chain: "K", resi: 1, label: null,  offset: [  0, 22,  +5], radius: 15, color: "#475569" },
  { chain: "K", resi: 2, label: "β'",  offset: [  0, 22, -22], radius: 15, color: "#475569" },

  // β subunit — LOWER jaw of the cleft (lobe + protrusion + flap).
  // Two-sphere extension matches β′ so the body looks visually
  // symmetric across the cleft.
  { chain: "Q", resi: 1, label: null,  offset: [  0,-22,  +5], radius: 15, color: "#64748b" },
  { chain: "Q", resi: 2, label: "β",   offset: [  0,-22, -22], radius: 15, color: "#64748b" },

  // ω subunit — β′-folding chaperone, on the β′ (upper) side of the
  // body, slightly UPSTREAM of rnapCenter so it sits behind the
  // upstream β′ sphere — keeps it from visually merging with the
  // downstream β′.  Source: Murakami 2015 (publications.md R5).
  { chain: "O", resi: 1, label: "ω",   offset: [-12, 16, -10], radius: 4,  color: "#1e293b" },
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
  // One sphere per region (was previously two for σ4 + two for σ2).  The
  // multi-sphere representation looked like duplicates rather than HTH /
  // 2.3-vs-2.4 sub-structure, and the canonical Santangelo Fig 1
  // (publications.md R1) shows σ⁷⁰ with one blob per region anyway.
  //
  // Y offsets brought DOWN from +26..+32 to +13..+15 — the regions now
  // sit just above the upstream DNA (y = 0) and just below the β′-clamp
  // top (y = +37), instead of floating well above the body.  W433's
  // anchor and inserted-position calc are independent (W433 anchors on
  // the helix axis at coord −11 along the local +Y radial), so this
  // change does NOT alter the W433 wedge animation.

  // σ4 — recognises −35 hexamer (HTH motif) ---------------------------------
  {
    resi: 1, region: "4",
    anchor: { kind: "promoter", coord: -35 },
    boundOffset: [4, 14, 0],
    labelAnchor: true, label: "σ4 (-35)",
  },

  // σ3 — spacer / extended −10 contacts -------------------------------------
  {
    resi: 2, region: "3",
    anchor: { kind: "promoter", coord: -22 },
    boundOffset: [0, 15, 0],
    labelAnchor: true, label: "σ3",
  },

  // σ2 — recognises −10 hexamer; region 2.3 is the W433 melt wedge ---------
  {
    resi: 3, region: "2",
    anchor: { kind: "promoter", coord: -10 },
    boundOffset: [-2, 13, 0],
    labelAnchor: true, label: "σ2 (-10)",
  },

  // σ1.1 — autoinhibitory NTD inside the RNAP cleft -------------------------
  // Anchored on rnapCenter, sits inside the body (occludes the main channel
  // until promoter escape).
  {
    resi: 4, region: "1.1",
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
// Hairpin target geometry — per-base (x, y, z) that each stem/loop/stem
// base is lerped toward during `hairpin_forming` (and held at during
// `detaching` if a terminator is annotated).
//
// Cached per (manifest, anchor-z) tuple so repeated calls during a
// frame redraw don't rebuild the table.  Anchor depends on the active-
// site Z so we invalidate when rnapCenter[2] moves; X / Y of the anchor
// are constants so they don't enter the cache key.
// -------------------------------------------------------------------------

interface HairpinTargets {
  /** Map from RNA base index k (0-based, 5′→3′) to scene-coord target. */
  byIndex: Map<number, [number, number, number]>;
  /** Inclusive lower bound of the hairpin-styled (chain H) range. */
  stemLo: number;
  /** Exclusive upper bound of the hairpin-styled (chain H) range. */
  stemHi: number;
  /** Loop midpoint (RNA index) — used by the per-base fold weight curve. */
  loopMid: number;
  /** Half the total stem-to-stem span in nt — denominator for the weight. */
  stemSpanHalf: number;
  /** Local-frame +x̂ unit vector in scene coords — perpendicular to the
   *  hairpin plane (yz_loc).  Used by the 5′ tail rebuild to offset the
   *  tail off the stem5 arm. */
  xLoc: [number, number, number];
}

const hairpinTargetsCache = new WeakMap<
  SimulationManifest,
  Map<string, HairpinTargets | null>
>();

function getHairpinTargets(
  manifest: SimulationManifest,
  anchor: [number, number, number],
): HairpinTargets | null {
  let perManifest = hairpinTargetsCache.get(manifest);
  if (!perManifest) {
    perManifest = new Map();
    hairpinTargetsCache.set(manifest, perManifest);
  }
  // Round the anchor Z to 0.1 Å so floating-point jitter doesn't blow
  // up the cache.  X / Y are constants in the current build, but key on
  // them too so a future move doesn't silently return stale entries.
  const key =
    anchor[0].toFixed(1) + "," +
    anchor[1].toFixed(1) + "," +
    anchor[2].toFixed(1);
  const cached = perManifest.get(key);
  if (cached !== undefined) return cached;

  const t = manifest.terminator;
  if (!t) {
    perManifest.set(key, null);
    return null;
  }
  const stemLen = t.stem5_end - t.stem5_start;
  const loopLen = t.loop_end - t.loop_start;
  if (stemLen < 1 || loopLen < 1) {
    perManifest.set(key, null);
    return null;
  }

  // Local frame: ẑ_loc along the existing exit-arm direction so the
  // hairpin opens in the same direction the chain-R tail already does.
  const stepMag = Math.hypot(RNA_EXIT_STEP_X, RNA_EXIT_STEP_Y, RNA_EXIT_STEP_Z);
  const zLoc: [number, number, number] = [
    RNA_EXIT_STEP_X / stepMag,
    RNA_EXIT_STEP_Y / stepMag,
    RNA_EXIT_STEP_Z / stepMag,
  ];
  // ŷ_loc = normalise(ẑ_loc × (+Z scene)) — perpendicular to both the
  // exit arm and to the upstream DNA tangent, so the hairpin opens
  // away from the DNA rather than into it.
  // ẑ_loc × (0,0,1) = (zLoc[1], -zLoc[0], 0)
  const yRaw: [number, number, number] = [zLoc[1], -zLoc[0], 0];
  const yMag = Math.hypot(yRaw[0], yRaw[1], yRaw[2]) || 1;
  const yLoc: [number, number, number] = [yRaw[0] / yMag, yRaw[1] / yMag, yRaw[2] / yMag];
  // x̂_loc = ẑ_loc × ŷ_loc — completes the right-handed frame.
  const xLoc: [number, number, number] = [
    zLoc[1] * yLoc[2] - zLoc[2] * yLoc[1],
    zLoc[2] * yLoc[0] - zLoc[0] * yLoc[2],
    zLoc[0] * yLoc[1] - zLoc[1] * yLoc[0],
  ];

  const S = HAIRPIN_STEM_RNA_RISE_A;
  const D = HAIRPIN_STEM_INTERARM_A;

  function localToScene(
    lx: number, ly: number, lz: number,
  ): [number, number, number] {
    return [
      anchor[0] + lx * xLoc[0] + ly * yLoc[0] + lz * zLoc[0],
      anchor[1] + lx * xLoc[1] + ly * yLoc[1] + lz * zLoc[1],
      anchor[2] + lx * xLoc[2] + ly * yLoc[2] + lz * zLoc[2],
    ];
  }

  const byIndex = new Map<number, [number, number, number]>();

  // 5′ stem arm: bases stem5_start..stem5_end-1 walk outward from the
  // anchor along +ẑ_loc, with +D/2 offset along +ŷ_loc.
  for (let k = t.stem5_start; k < t.stem5_end; k++) {
    const i = k - t.stem5_start; // 0..stemLen-1
    byIndex.set(k, localToScene(0, +D / 2, i * S));
  }
  // Loop: half-circle of radius D/2 in the (y, z) local plane,
  // connecting the stem5 5′-end (at y=+D/2) to the stem3 3′-end
  // (at y=-D/2) at z = stemLen·S.
  for (let k = t.loop_start; k < t.loop_end; k++) {
    const i = k - t.loop_start; // 0..loopLen-1
    const theta = Math.PI * (i / Math.max(loopLen - 1, 1));
    byIndex.set(
      k,
      localToScene(0, (D / 2) * Math.cos(theta), stemLen * S + (D / 2) * Math.sin(theta)),
    );
  }
  // 3′ stem arm: bases stem3_start..stem3_end-1 walk back toward the
  // anchor at y=-D/2, mirroring the 5′ arm.
  for (let k = t.stem3_start; k < t.stem3_end; k++) {
    const i = k - t.stem3_start; // 0..stemLen-1
    byIndex.set(k, localToScene(0, -D / 2, (stemLen - 1 - i) * S));
  }

  const result: HairpinTargets = {
    byIndex,
    stemLo: t.stem5_start,
    stemHi: t.stem3_end,
    loopMid: (t.loop_start + t.loop_end - 1) / 2,
    stemSpanHalf: Math.max((t.stem3_end - t.stem5_start) / 2, 1),
    xLoc,
  };
  perManifest.set(key, result);
  return result;
}

/**
 * Compute the global hairpin fold fraction F ∈ [0, 1] for the given
 * snapshot.  F = 0 → "home" (pre-fold) positions; F = 1 → fully formed
 * hairpin.  Returns 0 outside the relevant phases.
 */
function computeHairpinFold(
  manifest: SimulationManifest,
  snapshot: Snapshot,
): number {
  if (snapshot.phase === "hairpin_forming") {
    const ranges = getPhaseRanges(manifest);
    if (!ranges.hairpin) return 0;
    const span = Math.max(ranges.hairpin.end - ranges.hairpin.start, 1);
    return Math.min(1, Math.max(0, (snapshot.frame - ranges.hairpin.start) / span));
  }
  // Once the hairpin has formed it stays formed for the rest of the run.
  if (snapshot.phase === "detaching" && manifest.terminator) {
    return 1;
  }
  return 0;
}

/**
 * Per-base fold weight that zips the loop first and the stem ends last.
 * F is the global fold fraction; returns 0 when base k should sit at
 * its home position, 1 when it should sit at its hairpin target.
 */
function baseHairpinWeight(
  k: number,
  F: number,
  targets: HairpinTargets,
): number {
  if (F <= 0) return 0;
  if (F >= 1) return 1;
  const distFromLoop = Math.abs(k - targets.loopMid) / targets.stemSpanHalf;
  // F · (1 + d·c) − d·c — at d=0 (loop apex) weight = F; at d=1 (stem
  // end) weight = F − HAIRPIN_NUC_DIST_COEFF + F·HAIRPIN_NUC_DIST_COEFF.
  return Math.max(
    0,
    Math.min(
      1,
      F * (1 + distFromLoop * HAIRPIN_NUC_DIST_COEFF)
        - distFromLoop * HAIRPIN_NUC_DIST_COEFF,
    ),
  );
}

// -------------------------------------------------------------------------
// Per-RNA-base position table (used by the schematic builder).
//
// Replaces the three independent emission blocks (trapped coil / hybrid
// at template positions / chain-R 45° tail) with a single per-index
// position function.  This is the abstraction that makes the hairpin
// "drag back" possible without breaking the strand: every base k has
// one continuous position function so adjacent bases stay close even
// as the strand reshapes.
// -------------------------------------------------------------------------

type RnaChain = "T" | "R" | "H" | "U" | "X";

interface RnaBasePos {
  pos: [number, number, number];
  chain: RnaChain;
  /** 0..1 — used to fade chain H in as the hairpin folds. */
  weight: number;
  /** Per-base 5'→3' tangent in scene coordinates.  Used by the atomic-
   *  mode renderer to orient each RNA residue's atom template along the
   *  actual chain path (parallel to coding inside the hybrid; along
   *  RNA_EXIT_STEP for chain R; along the hairpin local frame's z_loc
   *  for chain H).  Schematic mode ignores this field. */
  tangent: [number, number, number];
}

interface RnaContext {
  manifest:           SimulationManifest;
  snapshot:           Snapshot;
  rnapCenter:         [number, number, number];
  backbone:           BaseAxisPoint[];
  bubbleLoIdx:        number;
  bubbleHiIdx:        number;
  hasBubble:          boolean;
  sigmaPresent:       boolean;
  effectiveHybridLen: number;
  showHybrid:         boolean;
  rnaAnchor:          [number, number, number];
  rnaAnchorBound:     [number, number, number];
}

/** Compute the position chain-R / chain-T would put base k at, ignoring
 *  any hairpin folding.  This is the "home" lerp source. */
function computeHomePositions(ctx: RnaContext): Array<{
  pos: [number, number, number];
  chain: "T" | "R";
}> {
  const rna = ctx.snapshot.rna_sequence;
  const n = rna.length;
  const out: Array<{ pos: [number, number, number]; chain: "T" | "R" }> =
    new Array(n);

  // -- σ bound: full RNA coiled inside RNAP (chain T trapped) ----------
  if (ctx.sigmaPresent && n > 0) {
    const turns = Math.min(2, n / 9);
    const coilR = 8;
    const zSpan = Math.min(12, n * 0.6);
    for (let k = 0; k < n; k++) {
      const angle = (k / Math.max(n, 1)) * turns * 2 * Math.PI;
      out[k] = {
        pos: [
          ctx.rnapCenter[0] + coilR * Math.cos(angle),
          ctx.rnapCenter[1] + coilR * Math.sin(angle),
          ctx.rnapCenter[2] - zSpan / 2 + (k / Math.max(n - 1, 1)) * zSpan,
        ],
        chain: "T",
      };
    }
    return out;
  }

  // -- σ released: chain-T hybrid at template positions + chain-R tail -
  const hybridStart = ctx.showHybrid ? n - ctx.effectiveHybridLen : n;

  // Hybrid bases (k = hybridStart .. n - 1) at template strand positions
  // inside the bubble, with a small −Y offset so they don't co-render
  // with the template spheres.
  for (let k = hybridStart; k < n; k++) {
    const offsetFrom3 = (n - 1) - k; // 0 = 3′-most base
    const tmplIdx = ctx.bubbleHiIdx - offsetFrom3;
    const tmplPt =
      tmplIdx >= 0 && tmplIdx < ctx.backbone.length
        ? ctx.backbone[tmplIdx]
        : ctx.backbone[ctx.bubbleHiIdx];
    const [tx, ty, tz] = strandPosition(
      tmplPt, -1, ctx.bubbleLoIdx, ctx.bubbleHiIdx,
    );
    out[k] = { pos: [tx, ty - 4, tz], chain: "T" };
  }

  // Chain-R tail anchor — next to the hybrid 5′ end when the hybrid
  // is shown, otherwise the standard exit-channel position (which
  // already incorporates the −X drift during detachment).
  let tailAnchor: [number, number, number];
  if (ctx.showHybrid) {
    const hybrid5Idx = Math.max(
      0,
      Math.min(
        ctx.bubbleHiIdx - (ctx.effectiveHybridLen - 1),
        ctx.backbone.length - 1,
      ),
    );
    const hybrid5Pt = ctx.backbone[hybrid5Idx];
    const [hx, hy, hz] = strandPosition(
      hybrid5Pt, -1, ctx.bubbleLoIdx, ctx.bubbleHiIdx,
    );
    tailAnchor = [
      hx + RNA_EXIT_STEP_X,
      hy - 4 + RNA_EXIT_STEP_Y,
      hz + RNA_EXIT_STEP_Z,
    ];
  } else {
    tailAnchor = ctx.rnaAnchor;
  }

  // Tail: bases 0..hybridStart-1 along the 45° arm, 3′-most base at
  // tailAnchor and earlier bases stepping further back in (-1.6, -1.6,
  // -2.4) Å increments.
  for (let k = 0; k < hybridStart; k++) {
    const armStep = (hybridStart - 1) - k;
    out[k] = {
      pos: [
        tailAnchor[0] + RNA_EXIT_STEP_X * armStep,
        tailAnchor[1] + RNA_EXIT_STEP_Y * armStep,
        tailAnchor[2] + RNA_EXIT_STEP_Z * armStep,
      ],
      chain: "R",
    };
  }

  return out;
}

/**
 * Build the per-base RNA position table for one snapshot.  Returns one
 * entry per RNA index (5′→3′) with scene-coord position, chain
 * routing, and per-base weight (used by chain H opacity).
 *
 * Phases:
 *   • σ bound, σ released without hairpin → identical to the original
 *     three-block emission (single source of truth).
 *   • hairpin_forming → loop bases zip to hairpin target first, stems
 *     follow; 5′ tail re-anchors on the lerped stem5 base each frame
 *     so the strand stays unbroken.
 *   • detaching with manifest.terminator → hairpin held at F = 1; the
 *     existing bubble-collapse animation handles the U-tract melt.
 */
function computeRnaBasePositions(ctx: RnaContext): RnaBasePos[] {
  const rna = ctx.snapshot.rna_sequence;
  const n = rna.length;
  if (n === 0) return [];

  const homes = computeHomePositions(ctx);
  const out: RnaBasePos[] = new Array(n);

  // Default routing — identical to the home computation.  Tangents are
  // a placeholder ([0,0,1]); the final pass at the end of this function
  // overwrites them with finite-differenced strand-direction tangents
  // so atomic mode can orient each residue's atom template along the
  // actual chain path.
  for (let k = 0; k < n; k++) {
    out[k] = { pos: homes[k].pos, chain: homes[k].chain, weight: 0, tangent: [0, 0, 1] };
  }

  // U-tract chain re-routing (chain T or R → chain U) — applied for
  // runs with a terminator annotation as soon as the U-tract has been
  // transcribed.  Same gate the SequencePanel uses (`termVisible`)
  // for showing terminator highlights.  Re-routing happens whether or
  // not the hairpin is folding, so the U-tract is pink throughout the
  // post-σ-release portion of the run, matching the panel's pink
  // `term-utract` highlight.
  //
  // Both T and R get caught: bases inside the hybrid arrive on chain T
  // via the home-positions logic; bases that have left the hybrid
  // (during the early-detach 5-frame bubble collapse) arrive on chain
  // R.  Without re-routing the R variant the U-tract would gradually
  // turn green as the bubble shrinks, contradicting the panel.
  const term = ctx.manifest.terminator;
  if (term && term.u_tract_end > term.u_tract_start && n >= term.stem3_start) {
    const uLo = term.u_tract_start;
    const uHi = Math.min(term.u_tract_end, n);
    for (let k = uLo; k < uHi; k++) {
      // Don't override the hairpin chain — bases in the stem range
      // get chain H below.  U-tract is by definition 3′ of stem3, so
      // there's no overlap with the stem range, but check defensively.
      if (out[k] && (out[k].chain === "T" || out[k].chain === "R")) {
        out[k].chain = "U";
      }
    }
  }

  // Hairpin overlay only meaningful after σ has released and the
  // engine has emitted a terminator annotation.  Keep behaviour
  // unchanged on σ-bound frames or unannotated runs.
  if (ctx.sigmaPresent) return out;
  const F = computeHairpinFold(ctx.manifest, ctx.snapshot);
  if (F <= 0) return out;
  if (!term) return out;

  // Anchor selection — place the hairpin's local-frame origin so the
  // stem3 3′-end base (k = stem3_end − 1) sits exactly one nt-spacing
  // back along the chain-R exit-arm direction from the U-tract first
  // base (k = stem3_end).  This makes the stem3 → U-tract junction
  // gap exactly one STEP magnitude (~3.3 Å), matching the 5′ tail to
  // stem5 attachment gap; both junctions read as the same one-nt
  // distance.  Falls back to stem3-3′-end home if the U-tract first
  // base isn't computable (e.g. no U-tract or run terminated early).
  //
  // Local frame: stem3 3′-end sits at local (0, -D/2, 0), so anchor =
  // (target stem3 3′-end position) + (0, +D/2, 0).
  const stem3LastIdx = term.stem3_end - 1;
  const uTractFirstHome = homes[term.stem3_end]?.pos;
  const stem3LastHome = homes[stem3LastIdx]?.pos;
  let anchor: [number, number, number];
  if (uTractFirstHome) {
    // Place stem3-3′-end at uTractFirstHome + STEP (one nt back along
    // the exit arm).  Anchor offsets that by (0, +D/2, 0) so the
    // stem3-3′-end at local (0, -D/2, 0) lands on the desired spot.
    anchor = [
      uTractFirstHome[0] + RNA_EXIT_STEP_X,
      uTractFirstHome[1] + RNA_EXIT_STEP_Y + HAIRPIN_STEM_INTERARM_A / 2,
      uTractFirstHome[2] + RNA_EXIT_STEP_Z,
    ];
  } else if (stem3LastHome) {
    anchor = [
      stem3LastHome[0],
      stem3LastHome[1] + HAIRPIN_STEM_INTERARM_A / 2,
      stem3LastHome[2],
    ];
  } else {
    anchor = ctx.rnaAnchor;
  }

  const targets = getHairpinTargets(ctx.manifest, anchor);
  if (!targets) return out;
  if (targets.stemHi > n) return out; // run terminated before stem fully transcribed

  // Lerp each stem/loop base from its home to its hairpin target.
  for (let k = targets.stemLo; k < targets.stemHi; k++) {
    const target = targets.byIndex.get(k);
    if (!target) continue;
    const w = baseHairpinWeight(k, F, targets);
    const home = homes[k].pos;
    out[k] = {
      pos: [
        home[0] * (1 - w) + target[0] * w,
        home[1] * (1 - w) + target[1] * w,
        home[2] * (1 - w) + target[2] * w,
      ],
      chain: "H",
      weight: w,
      tangent: [0, 0, 1], // placeholder — overwritten by final-pass below
    };
  }

  // Re-anchor the 5′ tail (k < stemLo) on the stem5 base's *current*
  // (lerped) position, walking back along the exit-arm direction so
  // adjacent k indices stay close.  Bases whose lerp moved them onto
  // the hairpin pull the tail in continuously.
  //
  // The chain-R STEP direction is collinear with the hairpin's +ẑ_loc
  // axis (the direction the stem5 arm extends along), so without a
  // perpendicular offset the 5′ tail bases land EXACTLY on top of the
  // stem5 arm bases (verified: 0.00 Å distance for the first ~5 tail
  // bases).  Offset the tail by `F · HAIRPIN_TAIL_PERP_OFFSET` in the
  // +x̂_loc direction (out of the hairpin plane) so the tail walks
  // parallel to the stem5 arm but ~1 nt-spacing away from it.  Scaling
  // by F keeps the pre-fold render unchanged (F = 0 → no offset →
  // identical to elongation chain-R behaviour).
  if (targets.stemLo > 0) {
    const stem5Pos = out[targets.stemLo].pos;
    const perp = F * HAIRPIN_TAIL_PERP_OFFSET;
    const offX = perp * targets.xLoc[0];
    const offY = perp * targets.xLoc[1];
    const offZ = perp * targets.xLoc[2];
    for (let k = targets.stemLo - 1; k >= 0; k--) {
      const armStep = targets.stemLo - k;
      out[k] = {
        pos: [
          stem5Pos[0] + offX + RNA_EXIT_STEP_X * armStep,
          stem5Pos[1] + offY + RNA_EXIT_STEP_Y * armStep,
          stem5Pos[2] + offZ + RNA_EXIT_STEP_Z * armStep,
        ],
        chain: "R",
        weight: 0,
        tangent: [0, 0, 1], // placeholder — overwritten by final-pass below
      };
    }
  }

  return out;
}

/**
 * Populate the `tangent` field on each RnaBasePos entry by finite-
 * differencing the position array.  Called once by `build()` after
 * `computeRnaBasePositions` so the placeholder tangents created above
 * are overwritten with values that follow the actual strand path —
 * including across hairpin folds and chain-switch junctions.
 *
 * Edge cases:
 *   • For the 5' end (k = 0) we use a forward difference.
 *   • For the 3' end (k = n-1) we use a backward difference.
 *   • For everything else, central difference.
 *   • Singular points (zero-length difference) get a sane default
 *     based on the chain identity.
 *
 * Schematic mode does not read tangents; this is purely for the
 * atomic emitter.  Cost is one extra O(n) pass over typical
 * transcripts of ≤ 100 nt.
 */
function computeRnaTangents(out: RnaBasePos[]): void {
  const n = out.length;
  if (n === 0) return;
  if (n === 1) {
    // Only one base — no neighbour to diff against.  Default to +Z.
    out[0].tangent = [0, 0, 1];
    return;
  }
  for (let k = 0; k < n; k++) {
    const prev = out[Math.max(0, k - 1)].pos;
    const next = out[Math.min(n - 1, k + 1)].pos;
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const dz = next[2] - prev[2];
    out[k].tangent = unitVec([dx, dy, dz]);
  }
}

// -------------------------------------------------------------------------
// Frozen RNA positions for the detaching phase.
//
// During "detaching" the bubble_downstream index shrinks one base per frame
// as the upstream half of the bubble re-anneals.  The hybrid RNA bases are
// anchored to bubbleHiIdx inside computeHomePositions, so as bubbleHiIdx
// decreases each frame the hybrid drifts upstream in Z — a visually jarring
// "snap-back" effect.
//
// Fix: capture the RNA scene positions at the very first detaching frame
// (detachFraction = 0, full-size bubble, no X-drift yet) and hold them
// frozen for all subsequent detach frames.  Only the X-drift animation
// (RNA drifting away as RNAP lifts) is applied on top as a rigid-body
// shift, so the strand stays put in Z while RNAP visibly lifts off.
// -------------------------------------------------------------------------

const frozenDetachRnaPositionsCache = new WeakMap<SimulationManifest, RnaBasePos[] | null>();

/**
 * Return the RNA base-position array frozen at the first detaching frame,
 * or null if no detach phase exists or the RNA is empty at that point.
 * Result is cached per manifest; safe to call every render frame.
 */
function getFrozenDetachRnaPositions(manifest: SimulationManifest): RnaBasePos[] | null {
  if (frozenDetachRnaPositionsCache.has(manifest)) {
    return frozenDetachRnaPositionsCache.get(manifest) ?? null;
  }

  const detachRange = getPhaseRanges(manifest).detach;
  if (!detachRange) {
    frozenDetachRnaPositionsCache.set(manifest, null);
    return null;
  }

  // Find the first snapshot whose frame == detach start.
  const firstDetachSnap = manifest.snapshots.find(s => s.frame === detachRange.start);
  if (!firstDetachSnap || firstDetachSnap.rna_sequence.length === 0) {
    frozenDetachRnaPositionsCache.set(manifest, null);
    return null;
  }

  // Compute backbone and context identical to what build() would produce for
  // the first detach frame (detachFraction = 0, liftY = 0).
  const tssIndex = manifest.sequence.tss_index;
  const len      = manifest.sequence.sequence_length;
  const fBubbleLoIdx = safeBackboneIdx(firstDetachSnap.bubble_upstream,   tssIndex, len);
  const fBubbleHiIdx = safeBackboneIdx(firstDetachSnap.bubble_downstream, tssIndex, len);
  const fBackbone    = computeBackbone(manifest, firstDetachSnap, fBubbleLoIdx, fBubbleHiIdx);
  const fBubbleSize  = Math.max(1, fBubbleHiIdx - fBubbleLoIdx);
  const fHasBubble   = fBubbleHiIdx > fBubbleLoIdx;

  const fPosIdx   = safeBackboneIdx(firstDetachSnap.position, tssIndex, fBackbone.length);
  const fRnapAxisZ = (fPosIdx - tssIndex) * RISE_PER_BP;
  // detachFraction = 0 at the first frame → liftY = 0
  const fRnapCenter: [number, number, number] = [0, 0, fRnapAxisZ];

  const fPresence       = getSigma70Presence(manifest, firstDetachSnap);
  const fSigmaPresent   = fPresence > 0.05;
  const fRna            = firstDetachSnap.rna_sequence;
  const fBaseHybridLen  = Math.min(fRna.length, HYBRID_LEN_SCHEMATIC);
  const fEffHybridLen   = fHasBubble ? Math.min(fBaseHybridLen, fBubbleSize) : 0;
  const fShowHybrid     = !fSigmaPresent && fHasBubble && fEffHybridLen > 0;

  // rnaAnchor at detach start: detachFraction = 0 → no X-drift, so
  // rnaAnchor = rnaAnchorBound exactly.
  const fRnaAnchorBound: [number, number, number] = [
    fRnapCenter[0] + RNA_EXIT_X_OFFSET,
    fRnapCenter[1] + RNA_EXIT_Y_OFFSET,
    fRnapCenter[2],
  ];

  const positions = computeRnaBasePositions({
    manifest,
    snapshot:          firstDetachSnap,
    rnapCenter:        fRnapCenter,
    backbone:          fBackbone,
    bubbleLoIdx:       fBubbleLoIdx,
    bubbleHiIdx:       fBubbleHiIdx,
    hasBubble:         fHasBubble,
    sigmaPresent:      fSigmaPresent,
    effectiveHybridLen: fEffHybridLen,
    showHybrid:        fShowHybrid,
    rnaAnchor:         fRnaAnchorBound,   // no drift at frame 0
    rnaAnchorBound:    fRnaAnchorBound,
  });
  computeRnaTangents(positions);

  frozenDetachRnaPositionsCache.set(manifest, positions);
  return positions;
}

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
    const atoms: Atom[] = [];
    let serial = 1;

    const tssIndex = manifest.sequence.tss_index;
    const len = manifest.sequence.sequence_length;
    const rawBubbleLoIdx = safeBackboneIdx(snapshot.bubble_upstream,   tssIndex, len);
    const rawBubbleHiIdx = safeBackboneIdx(snapshot.bubble_downstream, tssIndex, len);

    // The engine already animates bubble_downstream smoothly from its
    // termination value down to bubble_upstream over all 15 detach frames
    // (1 base per frame), so the renderer's old artificial early-collapse
    // override is no longer needed and was causing downstream-DNA drift.
    // Use the engine's values directly; computeBackbone's new bubbleEndZ
    // formula (bubbleSize * RISE_PER_BP) ensures downstream bases stay at
    // their natural B-helix positions throughout the collapse.
    const bubbleLoIdx = rawBubbleLoIdx;
    const bubbleHiIdx = rawBubbleHiIdx;
    const bubbleSize = Math.max(1, bubbleHiIdx - bubbleLoIdx);

    const backbone = computeBackbone(manifest, snapshot, bubbleLoIdx, bubbleHiIdx);
    const boneLen  = backbone.length;

    const coding   = manifest.sequence.coding_strand;
    const template = manifest.sequence.template_strand;

    // σ⁷⁰ presence — monotonic function of simulation time.
    const presence = getSigma70Presence(manifest, snapshot);
    // Needed early (before rnapAxisZ) to gate the scrunching vs elongation
    // RNAP-position logic below.
    const sigmaPresent = presence >= 0.9;
    // σ visual animations (domain drift, W433 departure) are held at their
    // fully-assembled pose while sigmaPresent is true, so they start moving
    // in the same frame as the RNAP jump and the timeline "releasing" state.
    // Raw `presence` is still used for the visibility gate (> 0.02) so σ
    // geometry fades out smoothly over the full releasing window.
    const sigmaVisualPresence = sigmaPresent ? 1.0 : presence;

    // Animation fractions for "approaching" and "detaching" phases.
    const { liftFactor, assembleFraction, detachFraction } = computeAnimationFractions(manifest, snapshot);
    const liftY = LIFT_HEIGHT_ANG * liftFactor;

    // RNAP body anchor — at the active site (catalytic centre), so the
    // body envelopes the bubble around the active site rather than
    // sitting ~11 nt upstream of it.  See computeBackbone for the
    // bubble-Z parameterisation.
    const positionIdx = safeBackboneIdx(snapshot.position, tssIndex, boneLen);
    const hasBubble = bubbleHiIdx > bubbleLoIdx;
    // RNAP Z anchor.
    //
    // σ⁷⁰ bound (initiation / scrunching): RNAP is physically clamped to the
    // promoter by σ⁷⁰.  `snapshot.position` advances as the active site
    // translocates downstream, but the RNAP *body* stays fixed at the TSS
    // (Z = 0).  It is the downstream DNA that is pulled INTO the RNAP cleft
    // (scrunching), not RNAP sliding along the DNA.  Lock rnapAxisZ = 0.
    //
    // σ⁷⁰ released (elongation / detach): RNAP translocates normally with
    // positionIdx.  Formula is the natural B-helix Z of the active-site index.
    const rnapAxisZ = sigmaPresent
      ? 0
      : (positionIdx - tssIndex) * RISE_PER_BP;
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

    // Template strand residue lookup — `template_strand` is stored 5'→3'
    // (Biopython convention), so `template[i]` is the complement of
    // `coding[len-1-i]`, NOT of `coding[i]`.  We want the chain B
    // sphere at scene-Z position i to show the base PAIRED WITH coding[i],
    // i.e. `template[len-1-i]`.  Same lookup the SequencePanel's
    // `templateAligned = reverse(template)` helper uses; previously
    // omitted in the schematic which silently mislabelled hover
    // tooltips for a year.  See publications.md R11.
    let prevB: number | null = null;
    for (const pt of backbone) {
      const [x0, y0, z0] = strandPosition(pt, -1, bubbleLoIdx, bubbleHiIdx);
      const atom: Atom = {
        elem: "P",
        x: x0, y: y0, z: z0,
        resn: dnaResn(template[len - 1 - pt.idx]),
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
        // canonical 90° camera rotation.  Skipped when su.label is null
        // (multi-sphere subunits emit one label only — see RNAP_SUBUNITS).
        if (su.label !== null) {
          labels.push({
            id: `subunit:${su.chain}:${su.resi}`,
            text: su.label,
            position: [sx, sy + su.radius + 3, sz],
            opacity: 1,
          });
        }
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

      const cx = boundX * sigmaVisualPresence + releasedCenter[0] * (1 - sigmaVisualPresence);
      const cy = (boundY * sigmaVisualPresence + releasedCenter[1] * (1 - sigmaVisualPresence)) + liftY;
      const cz = boundZ * sigmaVisualPresence + releasedCenter[2] * (1 - sigmaVisualPresence);

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
    //     (`presence >= 0.9`).  Hybrid window AND 5′ excess both go here —
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
    // sigmaPresent is defined earlier (before rnapAxisZ) — reused here.

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
    // Effective hybrid length.  In normal phases this is the full
    // 9-nt window (capped at rna.length).  During the early-detach
    // collapse animation it shrinks alongside the bubble so the hybrid
    // visibly melts into the exit thread, base by base.  Once the
    // bubble is fully closed (late detach) it's zero.
    //
    // The shrinkage falls out for free from clamping `hybridLen` to
    // `bubbleSize`: as the early-detach override shrinks bubbleHiIdx,
    // bubbleSize shrinks, and so does `effectiveHybridLen`.  Bases
    // that fall out of the hybrid window automatically appear in the
    // chain R tail block below (which uses `tailEnd = rna.length −
    // effectiveHybridLen`), so nothing is duplicated or lost.
    const baseHybridLen = Math.min(rna.length, HYBRID_LEN_SCHEMATIC);
    const effectiveHybridLen = hasBubble
      ? Math.min(baseHybridLen, bubbleSize)
      : 0;
    const showHybrid = !sigmaPresent && hasBubble && effectiveHybridLen > 0;

    // ----------------------------------------------------------------
    // RNA emission — single pass through the per-base position table.
    //
    // `computeRnaBasePositions` returns one entry per RNA index k with
    // a final scene position and a chain assignment (T / R / H).  This
    // replaces the three independent blocks (trapped coil / chain-T
    // hybrid / chain-R tail) the renderer used pre-2026-05-02 with a
    // single source of truth so the strand stays continuous through
    // hairpin folding and detachment.
    //
    // Chain choice is per-base, so we maintain three `prev*` serial
    // trackers and bond each atom to the previous atom *on the same
    // chain*.  Cross-chain visual continuity comes from proximity
    // (adjacent k indices have positions within ≈ 3.3 Å of each other
    // by construction) — same model the pre-refactor render used.
    // ----------------------------------------------------------------
    if (rna.length > 0) {
      // During detaching: use RNA positions frozen at the first detach frame
      // so the hybrid/tail don't drift upstream as the bubble collapses.
      // Apply only the X-drift animation as a rigid-body shift on top.
      let rnaPositions: RnaBasePos[];
      if (snapshot.phase === "detaching") {
        const frozen = getFrozenDetachRnaPositions(manifest);
        if (frozen !== null && frozen.length === rna.length) {
          const xShift = -RNA_DRIFT_X * detachFraction;
          rnaPositions = frozen.map(p => ({
            ...p,
            pos: [p.pos[0] + xShift, p.pos[1], p.pos[2]] as [number, number, number],
          }));
          // Tangents are shift-invariant; frozen copy is already correct.
        } else {
          // Fallback (frozen unavailable or RNA length mismatch).
          rnaPositions = computeRnaBasePositions({
            manifest, snapshot, rnapCenter, backbone, bubbleLoIdx, bubbleHiIdx,
            hasBubble, sigmaPresent, effectiveHybridLen, showHybrid, rnaAnchor, rnaAnchorBound,
          });
          computeRnaTangents(rnaPositions);
        }
      } else {
        rnaPositions = computeRnaBasePositions({
          manifest, snapshot,
          rnapCenter,
          backbone,
          bubbleLoIdx,
          bubbleHiIdx,
          hasBubble,
          sigmaPresent,
          effectiveHybridLen,
          showHybrid,
          rnaAnchor,
          rnaAnchorBound,
        });
        // Atomic-mode prep: finite-difference per-base tangents off the
        // final position array.  Schematic mode ignores the tangent
        // field; atomic mode reads it via the RnaBasePos exported below.
        computeRnaTangents(rnaPositions);
      }

      let prevT: number | null = null;
      let prevR: number | null = null;
      let prevH: number | null = null;
      let prevU: number | null = null;
      for (let k = 0; k < rna.length; k++) {
        const entry = rnaPositions[k];
        if (!entry) continue;
        const base = rna[k];
        const [x, y, z] = entry.pos;
        const atom: Atom = {
          // Chain-T uses oxygen elem (matches pre-refactor; styles.ts
          // colour-keys on chain not element).  Chain R/H/U use
          // phosphorus — same convention as the pre-refactor chain R.
          elem: entry.chain === "T" ? "O" : "P",
          x, y, z,
          resn: rnaResn(base),
          resi: k + 1,
          chain: entry.chain,
          serial: serial++,
          atomName: "P",
        };
        if (entry.chain === "T") {
          if (prevT !== null) { atom.bonds = [prevT]; atom.bondOrder = [1]; }
          prevT = atom.serial;
        } else if (entry.chain === "R") {
          if (prevR !== null) { atom.bonds = [prevR]; atom.bondOrder = [1]; }
          prevR = atom.serial;
        } else if (entry.chain === "H") {
          if (prevH !== null) { atom.bonds = [prevH]; atom.bondOrder = [1]; }
          prevH = atom.serial;
        } else /* "U" */ {
          if (prevU !== null) { atom.bonds = [prevU]; atom.bondOrder = [1]; }
          prevU = atom.serial;
        }
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
            // σ1.1 is part of σ⁷⁰, not RNAP.  Its bound Z must stay at the
            // promoter (Z = 0, the TSS) regardless of where RNAP has slid to
            // after promoter escape.  Before the scrunching fix rnapCenter[2]
            // was always 0 here (RNAP tracked position, but position=+1 during
            // approach → rnapAxisZ=0), so this is a no-op for the approach
            // phase; it only matters post-escape when RNAP has jumped downstream.
            anchorX = rnapCenter[0]; // always 0
            anchorY = 0;             // liftY added uniformly below
            anchorZ = 0;             // promoter / TSS, not rnapCenter[2]
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
          const x = assembledX * sigmaVisualPresence + releasedX * (1 - sigmaVisualPresence);
          const y = (assembledY * sigmaVisualPresence + releasedY * (1 - sigmaVisualPresence)) + liftY;
          const z = assembledZ * sigmaVisualPresence + releasedZ * (1 - sigmaVisualPresence);

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
              opacity: sigmaVisualPresence,
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
        //
        // In "schematic" mode, only regions 2 (-10) and 4 (-35) are drawn —
        // these are the most pedagogically relevant contacts.  σ3 (spacer)
        // and σ1.1 (inside RNAP) are suppressed to reduce visual clutter.
        const domainsToRender = options.sigma === "schematic"
          ? [LEGACY_SIGMA_DOMAINS[0], LEGACY_SIGMA_DOMAINS[2]] // σ4 + σ2 only
          : LEGACY_SIGMA_DOMAINS;
        let prevSigmaSerial: number | null = null;
        for (let d = 0; d < domainsToRender.length; d++) {
          const dom = domainsToRender[d];
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

          const x = assembledX * sigmaVisualPresence + releasedX * (1 - sigmaVisualPresence);
          const y = (assembledY * sigmaVisualPresence + releasedY * (1 - sigmaVisualPresence)) + liftY;
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

/* ------------------------------------------------------------------ */
/* Helpers exposed for the atomic-mode renderer                        */
/* ------------------------------------------------------------------ */

/**
 * Per-frame strand state — exactly what the atomic renderer needs to
 * lay out per-residue atom templates.  Includes:
 *  - the `BaseAxisPoint` array with per-base position, twist, and
 *    per-strand tangent;
 *  - bubble bounds (so the atomic emitter can call `strandPosition`
 *    with the same bounds the schematic used);
 *  - the RNA per-base position table (with chain routing + tangent).
 *
 * This is what the original schematic.build() consumes internally —
 * we just expose it so atomic.ts doesn't have to duplicate the
 * computation.  Cost: zero, both modes compute the same arrays once
 * per frame.
 */
export interface StrandFrame {
  backbone: BaseAxisPointPub[];
  bubbleLoIdx: number;
  bubbleHiIdx: number;
  rnaPositions: RnaBasePosPub[];
  rnapCenter: [number, number, number];
}

/** Public mirror of BaseAxisPoint so atomic.ts can read it without
 *  the internal interface being broadened.  Keep in sync. */
export interface BaseAxisPointPub {
  idx: number;
  coord: number;
  axis: [number, number, number];
  twist: number;
  tangent: [number, number, number];
  radial: [number, number, number];
  strandTangentCoding:   [number, number, number];
  strandTangentTemplate: [number, number, number];
  melted: boolean;
}

export interface RnaBasePosPub {
  pos: [number, number, number];
  chain: "T" | "R" | "H" | "U" | "X";
  weight: number;
  tangent: [number, number, number];
}

/**
 * Compute the strand state for a single snapshot.  Mirrors what
 * SchematicBuilder.build() does internally up to the point where it
 * starts emitting atoms.  Atomic mode then walks `backbone` for
 * chains A_at / B_at and `rnaPositions` for chains R_at / T_at /
 * H_at / U_at, emitting per-residue atom templates instead of
 * single spheres.
 */
export function computeStrandFrame(
  manifest: SimulationManifest,
  snapshot: Snapshot,
  _options: RenderOptions,
): StrandFrame {
  const tssIndex = manifest.sequence.tss_index;
  const len = manifest.sequence.sequence_length;
  const rawBubbleLoIdx = safeBackboneIdx(snapshot.bubble_upstream,   tssIndex, len);
  const rawBubbleHiIdx = safeBackboneIdx(snapshot.bubble_downstream, tssIndex, len);

  // The engine animates bubble_downstream smoothly during detaching;
  // use its values directly (same as the updated build() above).
  const bubbleLoIdx = rawBubbleLoIdx;
  const bubbleHiIdx = rawBubbleHiIdx;
  const bubbleSize = Math.max(1, bubbleHiIdx - bubbleLoIdx);

  const backbone = computeBackbone(manifest, snapshot, bubbleLoIdx, bubbleHiIdx);

  // RNAP centre + animation fractions — same logic as build().
  const { liftFactor, detachFraction } = computeAnimationFractions(manifest, snapshot);
  const liftY = LIFT_HEIGHT_ANG * liftFactor;
  const positionIdx = safeBackboneIdx(snapshot.position, tssIndex, backbone.length);
  const hasBubble = bubbleHiIdx > bubbleLoIdx;
  // σ⁷⁰ presence — needed before rnapAxisZ (scrunching lock logic).
  const presence = getSigma70Presence(manifest, snapshot);
  const sigmaPresent = presence >= 0.9;
  // RNAP Z anchor — same logic as build(): locked at Z=0 while σ is bound
  // (scrunching — DNA pulled into RNAP, not RNAP sliding), slides with
  // positionIdx once σ releases.
  const rnapAxisZ = sigmaPresent
    ? 0
    : (positionIdx - tssIndex) * RISE_PER_BP;
  const rnapCenter: [number, number, number] = [0, liftY, rnapAxisZ];

  // RNA chain assignment + positions — mirror of build().
  const rna = snapshot.rna_sequence;
  const baseHybridLen = Math.min(rna.length, HYBRID_LEN_SCHEMATIC);
  const effectiveHybridLen = hasBubble ? Math.min(baseHybridLen, bubbleSize) : 0;
  const showHybrid = !sigmaPresent && hasBubble && effectiveHybridLen > 0;
  const rnaAnchorBound: [number, number, number] = [
    rnapCenter[0] + RNA_EXIT_X_OFFSET,
    rnapCenter[1] + RNA_EXIT_Y_OFFSET,
    rnapCenter[2],
  ];
  const RNA_DRIFT_X = 50;
  const rnaAnchor: [number, number, number] =
    snapshot.phase === "detaching"
      ? [
          rnaAnchorBound[0] - RNA_DRIFT_X * detachFraction,
          RNA_EXIT_Y_OFFSET,
          rnaAnchorBound[2],
        ]
      : rnaAnchorBound;

  let rnaPositions: RnaBasePos[] = [];
  if (rna.length > 0) {
    // Detaching: freeze RNA at first-detach positions to stop upstream drift.
    if (snapshot.phase === "detaching") {
      const frozen = getFrozenDetachRnaPositions(manifest);
      if (frozen !== null && frozen.length === rna.length) {
        const xShift = -RNA_DRIFT_X * detachFraction;
        rnaPositions = frozen.map(p => ({
          ...p,
          pos: [p.pos[0] + xShift, p.pos[1], p.pos[2]] as [number, number, number],
        }));
        // Tangents are shift-invariant; frozen copy is already correct.
      } else {
        rnaPositions = computeRnaBasePositions({
          manifest, snapshot, rnapCenter, backbone, bubbleLoIdx, bubbleHiIdx,
          hasBubble, sigmaPresent, effectiveHybridLen, showHybrid, rnaAnchor, rnaAnchorBound,
        });
        computeRnaTangents(rnaPositions);
      }
    } else {
      rnaPositions = computeRnaBasePositions({
        manifest, snapshot,
        rnapCenter,
        backbone,
        bubbleLoIdx,
        bubbleHiIdx,
        hasBubble,
        sigmaPresent,
        effectiveHybridLen,
        showHybrid,
        rnaAnchor,
        rnaAnchorBound,
      });
      computeRnaTangents(rnaPositions);
    }

    // Remap backtracked RNA bases (the last backtrack_steps of the nascent
    // RNA) to chain X with secondary-channel coordinates.  The schematic
    // renderer emits separate chain-X spheres for these; the atomic renderer
    // uses rnaPositions, so we replace those terminal entries in-place so
    // that base identity (array index k → rna_sequence[k]) is preserved in
    // the atomic PDB emission while the positions are the secondary-channel
    // geometry rather than the active-site geometry.
    if (snapshot.backtrack_steps > 0) {
      // Secondary-channel step vector (matching SchematicBuilder.build()).
      const STEP_X = 3, STEP_Y = 0, STEP_Z = -0.5;
      const stepMag = Math.hypot(STEP_X, STEP_Y, STEP_Z);
      const tangent: [number, number, number] = [
        STEP_X / stepMag, STEP_Y / stepMag, STEP_Z / stepMag,
      ];
      const btStart = Math.max(0, rnaPositions.length - snapshot.backtrack_steps);
      for (let k = btStart; k < rnaPositions.length; k++) {
        const j = k - btStart;
        rnaPositions[k] = {
          pos: [
            rnapCenter[0] + 5 + j * STEP_X,
            rnapCenter[1] - 15 + j * STEP_Y,
            rnapCenter[2]      + j * STEP_Z,
          ],
          chain: "X",
          weight: 0,
          tangent,
        };
      }
    }
  }

  return {
    backbone,
    bubbleLoIdx,
    bubbleHiIdx,
    rnaPositions,
    rnapCenter,
  };
}

/**
 * Public version of `strandPosition` so atomic.ts can compute the
 * exact same per-base scene anchor the schematic uses.  Atomic mode
 * places the C1' of each residue at this position, then transforms
 * the residue's atom template by the local frame.
 */
export function strandScenePosition(
  pt: BaseAxisPointPub,
  strandSign: 1 | -1,
  bubbleLoIdx: number,
  bubbleHiIdx: number,
): [number, number, number] {
  return strandPosition(pt as BaseAxisPoint, strandSign, bubbleLoIdx, bubbleHiIdx);
}
