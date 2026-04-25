/**
 * Schematic (procedural) renderer.
 *
 * Draws a stylised, inspectable scene — not atomically accurate, but animates
 * smoothly because all positions are deterministic functions of the snapshot.
 *
 * Scene components (this file):
 *   • B-form double helix for both strands, upstream + downstream of bubble
 *   • Single-stranded coding & template strands inside the bubble
 *   • RNAP body: procedural crab-claw as two large-radius spheres
 *   • W433 indole ring as 10 atoms, lerped by snapshot.w433_depth
 *   • Nascent RNA thread emerging from the exit channel
 *   • Trapped RNA (chain T): RNA bases inside RNAP that cannot exit because
 *     the σ1.1 domain blocks the exit channel while σ⁷⁰ is still bound.
 *     Shown in amber alongside the normal RNA.
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
import type { Atom, GeometryBuilder, GeometryFrame } from "./types";
import type { SimulationManifest, Snapshot } from "../types/manifest";
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
): { liftFactor: number; assembleFraction: number } {
  const ranges = getPhaseRanges(manifest);
  const frame = snapshot.frame;

  let liftFactor = 0;
  let assembleFraction = 1;

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
    liftFactor = (frame - start) / span;      // starts 0, rises to 1
    assembleFraction = 1;                      // σ already gone during detach
  }

  return { liftFactor, assembleFraction };
}

// -------------------------------------------------------------------------
// σ⁷⁰ domain definitions
// -------------------------------------------------------------------------

/**
 * σ⁷⁰ has four structural domains that contact DNA and RNAP at known
 * positions.  Positions are TSS-relative so the domains track the promoter.
 */
interface SigmaDomain {
  label: string;
  coord: number;          // TSS-relative position on coding strand
  boundOffset: [number, number]; // (dy, dx) relative to helix axis at coord
  // Pre-assembly spread offset: where the domain floats before σ+core join.
  // Large values → domain starts far from RNAP body, converges to boundOffset.
  assemblySpread: [number, number]; // (dy_extra, dx_extra) added when assembly=0
}

const SIGMA_DOMAINS: SigmaDomain[] = [
  { label: "s4",  coord: -35, boundOffset: [28,  4],  assemblySpread: [30, 40] },
  { label: "s3",  coord: -22, boundOffset: [32,  0],  assemblySpread: [50, 20] },
  { label: "s2",  coord: -10, boundOffset: [28, -4],  assemblySpread: [40, -30] },
  { label: "s11", coord:  -2, boundOffset: [20, -8],  assemblySpread: [20, -50] },
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

  build(manifest: SimulationManifest, snapshot: Snapshot): GeometryFrame {
    const backbone = computeBackbone(manifest);
    const atoms: Atom[] = [];
    let serial = 1;

    const tssIndex = manifest.sequence.tss_index;
    const bubbleLoIdx = coordToIndex(snapshot.bubble_upstream,   tssIndex);
    const bubbleHiIdx = coordToIndex(snapshot.bubble_downstream, tssIndex);
    const rnapIdx = coordToIndex(snapshot.position, tssIndex);

    const coding   = manifest.sequence.coding_strand;
    const template = manifest.sequence.template_strand;

    // σ⁷⁰ presence — monotonic function of simulation time.
    const presence = getSigma70Presence(manifest, snapshot);

    // Animation fractions for "approaching" and "detaching" phases.
    const { liftFactor, assembleFraction } = computeAnimationFractions(manifest, snapshot);
    const liftY = LIFT_HEIGHT_ANG * liftFactor;

    // During approaching / detaching, the RNAP center also shifts in Y.
    const rnapAxisZ = backbone[Math.min(rnapIdx, backbone.length - 1)].axis[2];
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
    // RNAP body (chain P, residues 1–2) — two large spheres.
    // Lifted by liftY during "approaching" and "detaching".
    // ----------------------------------------------------------------
    atoms.push(
      { elem: "Fe", x: 0, y:  25 + liftY, z: rnapAxisZ, resn: "RPA", resi: 1, chain: "P", serial: serial++, atomName: "CA" },
      { elem: "Fe", x: 0, y: -25 + liftY, z: rnapAxisZ, resn: "RPA", resi: 2, chain: "P", serial: serial++, atomName: "CA" },
    );

    // ----------------------------------------------------------------
    // W433 indole (chain W) — only while σ⁷⁰ is attached.
    // Drifts away with σ⁷⁰ as presence fades.
    // ----------------------------------------------------------------
    if (presence > 0.02) {
      const w433TargetCoord = -11;
      const w433Idx = coordToIndex(w433TargetCoord, tssIndex);
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
    // When σ⁷⁰ is present, the σ1.1 domain physically blocks the RNAP
    // exit channel, so RNA cannot leave even if its length exceeds the
    // 9-nt hybrid window.  The excess bases (5′ end) are coiled inside
    // the RNAP body rather than threading out the exit channel.
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
        const x = rnapCenter[0] - t * armLen - 5;
        const y = rnapCenter[1] + Math.sin(t * Math.PI) * 10 + 10;
        const z = rnapCenter[2] + k * 0.8;
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
    // σ⁷⁰ four-domain cartoon (chain S)
    //
    // During "approaching":
    //   • "assembly" sub-animation (first 40 % of frames): domains start
    //     spread far apart (pre-assembly) and converge onto the RNAP body.
    //   • Remainder: domains at bound positions, whole complex lifted by liftY.
    //
    // During normal phases (presence > 0.02):
    //   • Bound positions track the promoter on the coding strand.
    //   • On promoter escape: lerp toward released positions (+x, +y).
    //
    // Released positions are the same as before; they stay offscreen once
    // σ⁷⁰ has departed.
    // ----------------------------------------------------------------
    if (presence > 0.02) {
      let prevSigmaSerial: number | null = null;
      for (let d = 0; d < SIGMA_DOMAINS.length; d++) {
        const dom = SIGMA_DOMAINS[d];
        const domIdx = coordToIndex(dom.coord, tssIndex);
        const axisZ = backbone[domIdx].axis[2];

        // Bound anchor — near the coding face at this promoter coord.
        const boundY = dom.boundOffset[0];
        const boundX = dom.boundOffset[1];

        // Released pose — drifts up and lateral after promoter escape.
        const releasedY = 75 + d * 3;
        const releasedX = 35 + d * 6;

        // Assembly animation: domains start spread and converge onto bound.
        const spreadY = dom.assemblySpread[0];
        const spreadX = dom.assemblySpread[1];
        // assembleX/Y is the lerp between spread-start and bound, driven by assembleFraction.
        const preAssembleX = boundX + spreadX;
        const preAssembleY = boundY + spreadY;
        const assembledX = boundX * assembleFraction + preAssembleX * (1 - assembleFraction);
        const assembledY = boundY * assembleFraction + preAssembleY * (1 - assembleFraction);

        // Presence lerp — shifts assembled position toward released when fading.
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

    const viewDistance = Math.max(80, manifest.sequence.sequence_length * 2);

    return {
      atoms,
      hints: { rnapCenter, viewDistance, sigma70Presence: presence },
    };
  }
}

export function createSchematicBuilder(): GeometryBuilder {
  return new SchematicBuilder();
}
