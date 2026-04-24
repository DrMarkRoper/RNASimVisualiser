/**
 * Schematic (procedural) renderer.
 *
 * Draws a stylised, inspectable scene — not atomically accurate, but animates
 * smoothly because all positions are deterministic functions of the snapshot.
 *
 * Scene components (this file):
 *   • B-form double helix for both strands, upstream + downstream of bubble
 *   • Single-stranded coding & template strands inside the bubble
 *   • RNAP body: procedural crab-claw as two large-radius spheres (placeholder
 *     until the full clamp/cleft mesh lands — see milestones 5–6)
 *   • W433 indole ring as 10 atoms, lerped by snapshot.w433_depth
 *   • Nascent RNA thread emerging from the exit channel
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
 * The bubble region is "straightened" by simply leaving axis positions on the
 * helix axis — the strand-specific displacement is zeroed out downstream for
 * bases inside the bubble, producing two single strands there.
 */
function computeBackbone(
  manifest: SimulationManifest,
): BaseAxisPoint[] {
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
 * Given a backbone point and a strand (coding = +1, template = -1),
 * return the displaced backbone atom position.  Inside the bubble, displacement
 * is reduced (strand melts away from the axis) so the two strands can be
 * drawn as separate single strands.
 */
function strandPosition(
  pt: BaseAxisPoint,
  strandSign: 1 | -1,
  melted: boolean,
): [number, number, number] {
  const [ax, ay, az] = pt.axis;
  const r = melted ? HELIX_RADIUS * 1.8 : HELIX_RADIUS;
  const phase = strandSign === 1 ? pt.twist : pt.twist + Math.PI;
  // When melted, also nudge template/coding apart along y for visual clarity.
  const yLift = melted ? strandSign * 4 : 0;
  return [ax + r * Math.cos(phase), ay + r * Math.sin(phase) + yLift, az];
}

/** Map DNA base char to 3Dmol-friendly residue name. */
function dnaResn(base: string): string {
  switch (base.toUpperCase()) {
    case "A":
      return "DA";
    case "T":
      return "DT";
    case "G":
      return "DG";
    case "C":
      return "DC";
    default:
      return "DN";
  }
}

function rnaResn(base: string): string {
  switch (base.toUpperCase()) {
    case "A":
      return "A";
    case "T":
    case "U":
      return "U";
    case "G":
      return "G";
    case "C":
      return "C";
    default:
      return "N";
  }
}

// NOTE: The former sigma70Presence(phase, position) lived here but was not
// monotonic — GreB cleavage and backtracking made its output rebound after
// promoter escape. The replacement is utils/sigma.getSigma70Presence, which
// anchors release on the first "promoter escape" event in the manifest and
// fades linearly over FADE_FRAMES frames. Import it directly when you need
// the factor for a given snapshot.

/**
 * σ⁷⁰ has four structural domains that contact DNA and RNAP at known
 * positions. In bound form: σ4 at -35, σ3 in spacer, σ2 at -10, σ1.1 near
 * the main channel.  In released form: domains drift upward and away.
 *
 * Positions are TSS-relative so the domains track the promoter under the
 * advancing RNAP.
 */
interface SigmaDomain {
  label: string;
  coord: number;          // TSS-relative position on coding strand
  boundOffset: [number, number]; // (dy, dx) relative to helix axis at coord
}

const SIGMA_DOMAINS: SigmaDomain[] = [
  { label: "s4",  coord: -35, boundOffset: [28, 4] },   // -35 recognition HTH
  { label: "s3",  coord: -22, boundOffset: [32, 0] },   // spacer
  { label: "s2",  coord: -10, boundOffset: [28, -4] },  // -10 recognition / melt
  { label: "s11", coord: -2,  boundOffset: [20, -8] },  // σ1.1 near channel
];

/**
 * 10-atom idealised indole ring (W433 side-chain surrogate).
 * Positions are scaled and then rotated/translated by the depth lerp.
 */
const INDOLE_TEMPLATE: Array<{ name: string; elem: string; x: number; y: number; z: number }> = [
  { name: "CG",  elem: "C", x: 0.00, y: 0.00, z: 0.00 },
  { name: "CD1", elem: "C", x: 1.36, y: 0.00, z: 0.00 },
  { name: "NE1", elem: "N", x: 2.10, y: 1.18, z: 0.00 },
  { name: "CE2", elem: "C", x: 1.24, y: 2.20, z: 0.00 },
  { name: "CD2", elem: "C", x: -0.08, y: 1.43, z: 0.00 },
  { name: "CE3", elem: "C", x: -1.22, y: 2.22, z: 0.00 },
  { name: "CZ3", elem: "C", x: -1.05, y: 3.60, z: 0.00 },
  { name: "CH2", elem: "C", x: 0.25, y: 4.17, z: 0.00 },
  { name: "CZ2", elem: "C", x: 1.39, y: 3.59, z: 0.00 },
  { name: "CA",  elem: "C", x: -1.20, y: -1.00, z: 0.00 }, // attachment point
];

class SchematicBuilder implements GeometryBuilder {
  readonly mode = "schematic" as const;

  build(manifest: SimulationManifest, snapshot: Snapshot): GeometryFrame {
    const backbone = computeBackbone(manifest);
    const atoms: Atom[] = [];
    let serial = 1;

    const tssIndex = manifest.sequence.tss_index;
    const bubbleLoIdx = coordToIndex(snapshot.bubble_upstream, tssIndex);
    const bubbleHiIdx = coordToIndex(snapshot.bubble_downstream, tssIndex);
    const rnapIdx = coordToIndex(snapshot.position, tssIndex);

    const coding = manifest.sequence.coding_strand;
    const template = manifest.sequence.template_strand;

    // σ⁷⁰ presence drives both the sigma cartoon and W433 visibility — W433
    // is a σ⁷⁰ region-2.3 residue, so it must leave the scene with the
    // holoenzyme, not linger on the DNA after escape. Presence is a
    // monotonic function of simulation time computed once per manifest; see
    // utils/sigma.
    const presence = getSigma70Presence(manifest, snapshot);

    // Coding strand (chain A) — one P atom per base, bonded to the next so
    // the `line` style in atomic mode draws a continuous backbone trace.
    let prevA: number | null = null;
    for (const pt of backbone) {
      const melted = pt.idx >= bubbleLoIdx && pt.idx <= bubbleHiIdx;
      const [x, y, z] = strandPosition(pt, +1, melted);
      const atom: Atom = {
        elem: "P",
        x,
        y,
        z,
        resn: dnaResn(coding[pt.idx]),
        resi: pt.idx + 1,
        chain: "A",
        serial: serial++,
        atomName: "P",
      };
      if (prevA !== null) {
        atom.bonds = [prevA];
        atom.bondOrder = [1];
      }
      prevA = atom.serial;
      atoms.push(atom);
    }

    // Template strand (chain B) — one P atom per base, bonded linearly.
    let prevB: number | null = null;
    for (const pt of backbone) {
      const melted = pt.idx >= bubbleLoIdx && pt.idx <= bubbleHiIdx;
      const [x, y, z] = strandPosition(pt, -1, melted);
      const atom: Atom = {
        elem: "P",
        x,
        y,
        z,
        resn: dnaResn(template[pt.idx]),
        resi: pt.idx + 1,
        chain: "B",
        serial: serial++,
        atomName: "P",
      };
      if (prevB !== null) {
        atom.bonds = [prevB];
        atom.bondOrder = [1];
      }
      prevB = atom.serial;
      atoms.push(atom);
    }

    // RNAP body (chain P, residues 1–2) — two big spheres centred on rnapIdx.
    const rnapAxisZ = backbone[rnapIdx].axis[2];
    const rnapCenter: [number, number, number] = [0, 0, rnapAxisZ];
    atoms.push(
      { elem: "Fe", x: 0, y: 25, z: rnapAxisZ, resn: "RPA", resi: 1, chain: "P", serial: serial++, atomName: "CA" },
      { elem: "Fe", x: 0, y: -25, z: rnapAxisZ, resn: "RPA", resi: 2, chain: "P", serial: serial++, atomName: "CA" },
    );

    // W433 indole (chain W, residue 433) — σ⁷⁰ region-2.3 residue. It only
    // exists in the scene while σ⁷⁰ is attached; during promoter escape it
    // drifts out with the rest of σ⁷⁰ and then disappears.
    if (presence > 0.02) {
      const w433TargetCoord = -11; // midpoint between -12 and -11
      const w433Idx = coordToIndex(w433TargetCoord, tssIndex);
      const targetZ = backbone[w433Idx].axis[2];
      const depth = snapshot.w433_depth;

      // Bound pose: interpolated retracted ↔ intercalated by w433_depth.
      const retractedCenter: [number, number, number] = [25, 0, targetZ];
      const insertedCenter: [number, number, number] = [HELIX_RADIUS * 0.6, 0, targetZ];
      const boundX = retractedCenter[0] * (1 - depth) + insertedCenter[0] * depth;
      const boundY = retractedCenter[1] * (1 - depth) + insertedCenter[1] * depth;
      const boundZ = retractedCenter[2] * (1 - depth) + insertedCenter[2] * depth;

      // Released pose: drifts with σ⁷⁰ domains (+x, +y) so it visibly
      // leaves the DNA rather than hovering over bases -11/-12.
      const releasedCenter: [number, number, number] = [38, 68, targetZ];

      const cx = boundX * presence + releasedCenter[0] * (1 - presence);
      const cy = boundY * presence + releasedCenter[1] * (1 - presence);
      const cz = boundZ * presence + releasedCenter[2] * (1 - presence);

      for (const a of INDOLE_TEMPLATE) {
        atoms.push({
          elem: a.elem,
          x: cx + a.x,
          y: cy + a.y,
          z: cz + a.z,
          resn: "TRP",
          resi: 433,
          chain: "W",
          serial: serial++,
          atomName: a.name,
        });
      }
    }

    // Nascent RNA (chain R) — one P atom per base, threaded out of the exit
    // channel along -x from the RNAP center.  Bonded linearly so atomic mode
    // draws the thread rather than disconnected spheres.
    let prevR: number | null = null;
    for (let k = 0; k < snapshot.rna_sequence.length; k++) {
      const base = snapshot.rna_sequence[k];
      const t = k / Math.max(snapshot.rna_sequence.length - 1, 1);
      const armLen = 4 * snapshot.rna_sequence.length;
      const x = rnapCenter[0] - t * armLen - 5;
      const y = rnapCenter[1] + Math.sin(t * Math.PI) * 10 + 10;
      const z = rnapCenter[2] + k * 0.8;
      const atom: Atom = {
        elem: "P",
        x,
        y,
        z,
        resn: rnaResn(base),
        resi: k + 1,
        chain: "R",
        serial: serial++,
        atomName: "P",
      };
      if (prevR !== null) {
        atom.bonds = [prevR];
        atom.bondOrder = [1];
      }
      prevR = atom.serial;
      atoms.push(atom);
    }

    // Backtracked RNA (chain X) — displaced thread into the secondary channel.
    if (snapshot.backtrack_steps > 0) {
      let prevX: number | null = null;
      for (let k = 0; k < snapshot.backtrack_steps; k++) {
        const x = rnapCenter[0] + 5 + k * 3;
        const y = rnapCenter[1] - 15;
        const z = rnapCenter[2] - k * 0.5;
        const atom: Atom = {
          elem: "P",
          x,
          y,
          z,
          resn: "N",
          resi: k + 1,
          chain: "X",
          serial: serial++,
          atomName: "P",
        };
        if (prevX !== null) {
          atom.bonds = [prevX];
          atom.bondOrder = [1];
        }
        prevX = atom.serial;
        atoms.push(atom);
      }
    }

    // σ⁷⁰ four-domain cartoon (chain S).  Bound positions follow the promoter
    // on the coding strand; released positions drift upward (+y) and away
    // (+x).  Domains are bonded in linear order so 3Dmol's line style draws
    // a connecting backbone through them.
    if (presence > 0.02) {
      let prevSigmaSerial: number | null = null;
      for (let d = 0; d < SIGMA_DOMAINS.length; d++) {
        const dom = SIGMA_DOMAINS[d];
        const domIdx = coordToIndex(dom.coord, tssIndex);
        const axisZ = backbone[domIdx].axis[2];

        // Bound anchor: near the coding face at this promoter coord.
        const boundY = dom.boundOffset[0];
        const boundX = dom.boundOffset[1];

        // Released pose: ~50 Å up and 35 Å lateral, spread out so the four
        // domains don't overlap after release.
        const releasedY = 75 + d * 3;
        const releasedX = 35 + d * 6;

        const x = boundX * presence + releasedX * (1 - presence);
        const y = boundY * presence + releasedY * (1 - presence);
        const z = axisZ;

        const atom: Atom = {
          elem: "C",
          x,
          y,
          z,
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
