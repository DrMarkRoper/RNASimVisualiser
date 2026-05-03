/**
 * Atomic renderer.
 *
 * Two responsibilities:
 *
 * 1. **Overall atomic mode** (`mode === "atomic"`) — `AtomicBuilder`
 *    builds the schematic frame and strips the procedural protein
 *    chains so the 6ALF PDB cartoon (loaded by Viewer3D from RCSB)
 *    supplies them.  No per-strand atom emission here; that's
 *    handled by (2) regardless of overall mode.
 *
 * 2. **Per-strand atomic representation** (`options.coding/template/rna
 *    === "atomic"`) — `emitAtomicPdbText` returns a PDB-format
 *    string covering every atom of every residue on each strand
 *    that's been flipped to "atomic".  Viewer3D loads this into a
 *    separate 3Dmol model via `addModel(pdbText, "pdb")`, which
 *    triggers 3Dmol's PDB parser — and crucially its standard
 *    nucleic-acid bond-assignment logic, so sugar rings render as
 *    clean pentagons and base rings as proper aromatic hexagons /
 *    fused 5+6.  An earlier attempt at threading explicit bonds
 *    via `addAtoms` produced cross-bonded rings (3Dmol's internal
 *    template overrode our explicit bonds inconsistently) — see
 *    test page at `/atomic_test.html` for the comparison.
 *
 *    No per-frame PDB fetch from RCSB — the per-residue atom
 *    templates are baked into `atomicResidues.ts` and transformed
 *    by the same backbone / RNA-position arrays the schematic
 *    produces.  See publications.md R11–R14 for the orientation
 *    rules and the source of the templates.
 *
 * Atomic chain IDs in the emitted PDB are single-character (A=coding,
 * B=template, R=RNA exit, T=hybrid, H=hairpin, U=U-tract) per the
 * PDB ATOM-record column constraint.  These collide with the
 * dynamic model's band chain IDs but are namespaced because each
 * 3Dmol model is queried via `{model, chain}` selectors.
 */
import type { Atom, GeometryBuilder, GeometryFrame } from "./types";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { RenderOptions } from "../components/RenderOptionsButton";
import {
  createSchematicBuilder,
  computeStrandFrame,
  strandScenePosition,
  SCHEMATIC_HELIX_RADIUS,
  SCHEMATIC_RISE_PER_BP,
  SCHEMATIC_TWIST_PER_BP,
  type BaseAxisPointPub,
  type RnaBasePosPub,
} from "./schematic";

/**
 * Real B-DNA pairing geometry (verified against the user-supplied
 * `93347154ABD.pdb` reference structure).
 *
 * Numerical findings from the sample:
 *   - Paired C1' atoms at +76° angular offset (CCW from coding
 *     looking down +Z).  |C1'-C1'| ≈ 10.87 Å.
 *   - W-C H-bond at ≈ 2.96 Å (N3-T → N1-A).
 *   - **P angular offset** between paired strands ≈ +135° to +147°
 *     (mostly +140°).  This is what matters for the CARTOON RIBBON
 *     visual separation, since 3Dmol traces the cartoon through
 *     the P atoms.  The P offset is much wider than the C1' offset
 *     because P sits at a chirality-dependent rotational offset
 *     from C1' on each strand, and the two strands have OPPOSITE
 *     P-vs-C1' chiralities (antiparallel polarity).
 *
 * **Sign matters.**  +76° (CCW) and -68° (CW, also "short way
 * around") are DIFFERENT angular positions modulo 360° (they're
 * 144° apart), and produce different local-frame chiralities.
 * The +76° version reproduces the sample's P-P angular offset
 * (verified numerically: +76° gives P-P ≈ +135°, matching the
 * sample); -68° gives P-P ≈ -9° (visually stacked ribbons, the
 * bug we were chasing).
 *
 * Inside the bubble the strands are unpaired (melted) and follow
 * individual paths via the schematic's strandPosition + bulge
 * envelope; the override is bypassed there.
 */
const TEMPLATE_PAIRING_OFFSET_RAD = +76 * Math.PI / 180;
import {
  emitResidueAtoms,
  getResidueBonds,
  residueKey,
  type EmittedAtom,
  type ResidueKind,
} from "./atomicResidues";

/** Procedural RNAP / σ chains that must be hidden when the PDB cartoon
 *  is loaded — otherwise the schematic mesh duplicates the 6ALF
 *  subunits.  Includes the legacy "P" placeholder, σ⁷⁰ chains "S"
 *  (legacy four-domain) and "M" (new four-region mesh), plus the
 *  five per-subunit chains added by the RNAP mesh refactor. */
const PROCEDURAL_PROTEIN_CHAINS = new Set(["P", "S", "M", "Y", "Z", "Q", "K", "O"]);

/** RNA chain → atomic-mode sister chain. */
const ATOMIC_RNA_CHAIN: Record<string, string> = {
  T: "T_at",
  R: "R_at",
  H: "H_at",
  U: "U_at",
};

/** Lookup whether each strand should be emitted as atomic-chain
 *  geometry this frame.  Triggered solely by the per-component
 *  pick being `"atomic"`; the representation pill (Molecular /
 *  Cartoon / Both) only controls how the resulting atomic chain is
 *  STYLED, not whether atoms are emitted at all.  We always emit
 *  the underlying atom set so a representation flip doesn't require
 *  a rebuild — Viewer3D's per-frame style logic takes over from
 *  there. */
function atomicStrandFlags(options: RenderOptions): {
  coding: boolean;
  template: boolean;
  rna: boolean;
} {
  return {
    coding:   options.coding   === "atomic",
    template: options.template === "atomic",
    rna:      options.rna      === "atomic",
  };
}

/**
 * Convert one residue's emitted-atom array into per-frame `Atom`
 * records ready for 3Dmol.  Threads BOTH intra-residue bonds (from
 * the residue's bond table — backbone, sugar ring, base ring,
 * glycosidic) and an empty inter-residue placeholder; the caller
 * fills in the inter-residue P↔O3' bond once consecutive residues
 * are known.
 *
 * The intra-residue bonds are what 3Dmol's `stick` style needs to
 * render the bonds as cylinders.  Without them, only `sphere` style
 * applies and the residue reads as a cluster of disconnected dots.
 */
function emittedToAtoms(
  emitted: EmittedAtom[],
  resName: string,
  resi: number,
  chain: string,
  startSerial: number,
  base: string,
  kind: ResidueKind,
): { atoms: Atom[]; nameToSerial: Map<string, number> } {
  const atoms: Atom[] = new Array(emitted.length);
  const nameToSerial = new Map<string, number>();
  for (let i = 0; i < emitted.length; i++) {
    const e = emitted[i];
    const serial = startSerial + i;
    atoms[i] = {
      elem: e.elem,
      x: e.pos[0], y: e.pos[1], z: e.pos[2],
      resn: resName,
      resi,
      chain,
      serial,
      atomName: e.name,
      bonds: [],
      bondOrder: [],
    };
    nameToSerial.set(e.name, serial);
  }
  // Thread intra-residue bonds.  Each bond is symmetric — set both
  // halves so 3Dmol's stick renderer doesn't miss the cylinder
  // depending on which atom it iterates first.
  const bondTable = getResidueBonds(base, kind);
  for (const [na, nb] of bondTable) {
    const sa = nameToSerial.get(na);
    const sb = nameToSerial.get(nb);
    if (sa === undefined || sb === undefined) continue;
    const aA = atoms.find(a => a.serial === sa);
    const aB = atoms.find(a => a.serial === sb);
    if (!aA || !aB) continue;
    aA.bonds = [...(aA.bonds ?? []), sb];
    aA.bondOrder = [...(aA.bondOrder ?? []), 1];
    aB.bonds = [...(aB.bonds ?? []), sa];
    aB.bondOrder = [...(aB.bondOrder ?? []), 1];
  }
  return { atoms, nameToSerial };
}
// Suppress unused-import warnings — residueKey is exported by
// atomicResidues.ts but we don't need it here.  Kept in the
// import block for future extension and ts-prune cleanliness.
void residueKey;

/**
 * Walk a strand and emit one residue's worth of atoms per base.
 *
 * @param strand    "A" for coding, "B" for template
 * @param chainAt   the atomic-mode chain id (e.g. "A_at")
 * @param backbone  per-base BaseAxisPoint array from computeStrandFrame
 * @param resnames  per-base residue name (e.g. "DA","DT", …); the
 *                  caller looks this up so this function doesn't have
 *                  to know the manifest's strand strings
 * @param strandSign  +1 = coding, -1 = template (passed to strandPosition)
 * @param tangentField  which BaseAxisPoint tangent to use as the
 *                      strand 5'→3' direction.  Coding uses
 *                      strandTangentCoding; template uses
 *                      strandTangentTemplate (already negated for
 *                      antiparallel polarity in computeBackbone).
 * @param bubbleLoIdx
 * @param bubbleHiIdx
 * @param kind   "DNA" for both A and B (the engine never emits RNA
 *               on a DNA strand)
 * @param startSerial   first serial number to use; returns the next
 *                      free serial after emission
 */
function emitStrand(
  strand: "A" | "B",
  chainAt: string,
  backbone: BaseAxisPointPub[],
  resnames: string[],
  strandSign: 1 | -1,
  tangentField: "strandTangentCoding" | "strandTangentTemplate",
  bubbleLoIdx: number,
  bubbleHiIdx: number,
  kind: ResidueKind,
  startSerial: number,
): { atoms: Atom[]; nextSerial: number } {
  const all: Atom[] = [];
  let serial = startSerial;
  let prevO3Serial: number | null = null;
  // Render-index iteration walks from low Z to high Z.  For the
  // CODING strand this is the 5'→3' direction (so the bond O3'(i) ↔
  // P(i+1) goes "previous-O3 → current-P").  For the TEMPLATE strand
  // 5'→3' runs from high Z to low Z (antiparallel), so we walk render
  // indices in REVERSE for template — that way "previous" still means
  // 5'-ward, and the same prev-O3 → current-P bond pattern works for
  // both strands.
  const reverseIter = strandSign === -1;
  const indices: number[] = reverseIter
    ? Array.from({ length: backbone.length }, (_, k) => backbone.length - 1 - k)
    : Array.from({ length: backbone.length }, (_, k) => k);
  // `chainResi` is the ATOMIC-CHAIN-LOCAL residue number (1, 2, 3, …
  // in iteration order).  This MUST be monotonically increasing in
  // iteration order so 3Dmol's `cartoon` style can trace a single
  // ribbon through the chain — it walks residues by resi value
  // looking for consecutive P-O3' connectivity.  For the coding
  // strand (forward iter) it equals render-index + 1; for the
  // template strand (reverse iter) it equals
  // (backbone.length − render-index), so resi 1 sits at template's
  // 5' end (the high-Z end of the duplex) and resi N at the 3' end.
  // Hover labels show this chain-local resi rather than the
  // sequence position; the band chain (B) keeps the original
  // sequence-position convention.
  let chainResi = 0;
  for (const i of indices) {
    chainResi++;
    const pt = backbone[i];
    // C1' position.
    //
    // Coding strand uses the schematic's `strandPosition` directly.
    // Template strand uses the schematic position INSIDE the bubble
    // (where strands are melted and follow individual paths) but
    // overrides the position OUTSIDE the bubble to match real B-DNA
    // pairing geometry: paired C1' atoms at +76° angular offset
    // (= −68° going the short way around the axis), |C1'-C1'| ≈
    // 10.87 Å, with bases extending toward each other for canonical
    // Watson-Crick pairing.  Verified against the
    // 93347154ABD.pdb reference — see TEMPLATE_PAIRING_OFFSET_RAD.
    let c1: [number, number, number];
    const inBubble = pt.idx >= bubbleLoIdx && pt.idx <= bubbleHiIdx;
    if (strandSign === 1 || inBubble) {
      c1 = strandScenePosition(pt, strandSign, bubbleLoIdx, bubbleHiIdx);
    } else {
      // Template, outside bubble: override.
      const phase = pt.twist - SCHEMATIC_TWIST_PER_BP + TEMPLATE_PAIRING_OFFSET_RAD;
      const R = SCHEMATIC_HELIX_RADIUS;
      c1 = [
        pt.axis[0] + R * Math.cos(phase),
        pt.axis[1] + R * Math.sin(phase),
        pt.axis[2],
      ];
    }
    const tangent = pt[tangentField];
    // Outward direction: AXIS-RELATIVE (perpendicular from the helix
    // axis to this strand's C1', projected perpendicular to tangent).
    //
    // This MUST match the baking convention (atomicResidues.ts uses
    // axis-relative +y_local), so each residue's atoms reproduce the
    // sample PDB's geometry within ~0.2 Å when emitted at the
    // corresponding sample C1' position.  Verified numerically:
    // emitting DA at sample strand-2 resi-23's C1' with this
    // outward + ez=-Z recovers the sample's atom positions.
    //
    // We DO NOT use partner-relative outward (it tilts the local
    // frame away from the baking convention, producing a P-P
    // angular offset of ~112° vs the sample's ~135°, and visibly
    // overlapping cartoon ribbons).
    const radial: [number, number, number] = [
      c1[0] - pt.axis[0],
      c1[1] - pt.axis[1],
      c1[2] - pt.axis[2],
    ];
    const dotRT = radial[0] * tangent[0] + radial[1] * tangent[1] + radial[2] * tangent[2];
    let outward: [number, number, number] = [
      radial[0] - dotRT * tangent[0],
      radial[1] - dotRT * tangent[1],
      radial[2] - dotRT * tangent[2],
    ];
    let mag = Math.hypot(outward[0], outward[1], outward[2]);
    if (mag < 1e-6) {
      // Degenerate (C1' on the axis): use +Y projected perpendicular
      // to tangent as a fallback so the residue still renders.
      outward = [0, 1, 0];
      mag = 1;
    }
    outward = [outward[0] / mag, outward[1] / mag, outward[2] / mag];
    const emitted = emitResidueAtoms(resnames[i] ?? "A", kind, {
      c1Pos: c1,
      tangent,
      outward,
      twist: 0, // outward already encodes the helical phase
    });
    const baseChar = resnames[i] ?? "A";
    const { atoms, nameToSerial } = emittedToAtoms(
      emitted,
      kind === "DNA" ? `D${baseChar[0].toUpperCase()}` : baseChar.toUpperCase(),
      chainResi,
      chainAt,
      serial,
      baseChar,
      kind,
    );
    serial += atoms.length;
    // Inter-residue bond: O3' of previous residue ↔ P of this residue.
    // Set BOTH directions so 3Dmol's stick renderer doesn't miss the
    // cylinder depending on iteration order.
    const pSerial = nameToSerial.get("P");
    if (prevO3Serial !== null && pSerial !== undefined) {
      const pAtom = atoms.find(a => a.serial === pSerial);
      const prevO3Atom = all.find(a => a.serial === prevO3Serial);
      if (pAtom) {
        pAtom.bonds = [...(pAtom.bonds ?? []), prevO3Serial];
        pAtom.bondOrder = [...(pAtom.bondOrder ?? []), 1];
      }
      if (prevO3Atom) {
        prevO3Atom.bonds = [...(prevO3Atom.bonds ?? []), pSerial];
        prevO3Atom.bondOrder = [...(prevO3Atom.bondOrder ?? []), 1];
      }
    }
    prevO3Serial = nameToSerial.get("O3'") ?? null;
    all.push(...atoms);
  }

  // 3' phantom residue.
  //
  // 3Dmol's nucleic-acid cartoon style drops the LAST residue of each
  // chain from its trace (no "next" residue to define the trace
  // continuation), which would hide the actual N-th real base block.
  // We emit one extra phantom residue at chainResi=N+1, positioned
  // exactly where the N+1-th residue would sit on the helix
  // (extrapolated from the last real backbone point along the strand
  // 5'→3' direction), so the cartoon trims THAT phantom instead of a
  // real residue.  The phantom's atoms get hidden by the
  // representation logic in Viewer3D (the cartoon ribbon's edge trim
  // means it's barely visible anyway, and 3Dmol's stick/sphere edge
  // is non-trimmed but at the helix's natural extension — looks like
  // a faint extra base step that's visually unobjectionable).
  //
  // For coding (forward iter): phantom one base step PAST the last
  // real residue (at scene-z = lastRealZ + RISE).
  // For template (reverse iter): phantom one base step BELOW the last
  // real residue (at scene-z = lastRealZ − RISE), since template's
  // 5'→3' goes -Z.
  if (indices.length > 0) {
    const lastRenderIdx = indices[indices.length - 1];
    const lastPt = backbone[lastRenderIdx];
    chainResi++; // = N+1 after the loop
    // Compute phantom C1' position one step further along the strand.
    const phantomTwist =
      lastPt.twist + (strandSign === 1 ? +SCHEMATIC_TWIST_PER_BP : -SCHEMATIC_TWIST_PER_BP);
    const phantomZ =
      lastPt.axis[2] + (strandSign === 1 ? +SCHEMATIC_RISE_PER_BP : -SCHEMATIC_RISE_PER_BP);
    const R = SCHEMATIC_HELIX_RADIUS;
    let phantomPhase: number;
    if (strandSign === 1) {
      phantomPhase = phantomTwist;
    } else {
      phantomPhase = phantomTwist + TEMPLATE_PAIRING_OFFSET_RAD;
    }
    const phantomC1: [number, number, number] = [
      lastPt.axis[0] + R * Math.cos(phantomPhase),
      lastPt.axis[1] + R * Math.sin(phantomPhase),
      phantomZ,
    ];
    const phantomTangent: [number, number, number] =
      strandSign === 1 ? [0, 0, 1] : [0, 0, -1];
    const phantomOutward: [number, number, number] = [
      Math.cos(phantomPhase),
      Math.sin(phantomPhase),
      0,
    ];
    // Use the LAST real residue's base for the phantom — visually
    // arbitrary; the phantom is a cartoon-trim sacrifice and its
    // base identity isn't biologically meaningful.
    const phantomBase = resnames[lastRenderIdx] ?? "A";
    const phantomEmitted = emitResidueAtoms(phantomBase, kind, {
      c1Pos: phantomC1,
      tangent: phantomTangent,
      outward: phantomOutward,
      twist: 0,
    });
    const { atoms: phantomAtoms, nameToSerial: phantomNameToSerial } =
      emittedToAtoms(
        phantomEmitted,
        kind === "DNA" ? `D${phantomBase[0].toUpperCase()}` : phantomBase.toUpperCase(),
        chainResi,
        chainAt,
        serial,
        phantomBase,
        kind,
      );
    serial += phantomAtoms.length;
    // Inter-residue bond: phantom's P ↔ last real residue's O3'.
    const phantomP = phantomNameToSerial.get("P");
    if (prevO3Serial !== null && phantomP !== undefined) {
      const pAtom = phantomAtoms.find(a => a.serial === phantomP);
      const prevO3Atom = all.find(a => a.serial === prevO3Serial);
      if (pAtom) {
        pAtom.bonds = [...(pAtom.bonds ?? []), prevO3Serial];
        pAtom.bondOrder = [...(pAtom.bondOrder ?? []), 1];
      }
      if (prevO3Atom) {
        prevO3Atom.bonds = [...(prevO3Atom.bonds ?? []), phantomP];
        prevO3Atom.bondOrder = [...(prevO3Atom.bondOrder ?? []), 1];
      }
    }
    all.push(...phantomAtoms);
  }

  return { atoms: all, nextSerial: serial };
}

/**
 * Walk the RNA per-base position array and emit one residue's atoms
 * per base, routed onto the matching atomic-mode chain (T_at / R_at /
 * H_at / U_at).  Inter-residue bonds are threaded per chain, same as
 * the schematic does for chain T/R/H/U.
 */
function emitRna(
  rnaPositions: RnaBasePosPub[],
  rnaSeq: string,
  startSerial: number,
): { atoms: Atom[]; nextSerial: number } {
  const all: Atom[] = [];
  let serial = startSerial;
  // Per-chain "previous O3' serial" — bonds chain a residue's P to the
  // previous residue's O3' on the SAME chain.
  const prevO3: Record<string, number | null> = {
    T_at: null, R_at: null, H_at: null, U_at: null,
  };
  for (let k = 0; k < rnaPositions.length; k++) {
    const entry = rnaPositions[k];
    const chainAt = ATOMIC_RNA_CHAIN[entry.chain];
    if (!chainAt) continue;
    const base = rnaSeq[k] ?? "A";
    // RNA residue local frame.  Outward defaults to +Y; for atoms-on
    // the hairpin / exit channel the meaningful axis is the per-base
    // tangent, and we don't have a strict "outward" — pick a
    // perpendicular-ish vector that doesn't degenerate.  We compute
    // `outward` as the projection of +Y onto the plane perpendicular
    // to tangent, falling back to +X if tangent is itself ~ +Y.
    const t = entry.tangent;
    const upY: [number, number, number] = [0, 1, 0];
    const dot = t[0] * upY[0] + t[1] * upY[1] + t[2] * upY[2];
    let outward: [number, number, number] = [
      upY[0] - dot * t[0],
      upY[1] - dot * t[1],
      upY[2] - dot * t[2],
    ];
    let mag = Math.hypot(outward[0], outward[1], outward[2]);
    if (mag < 0.1) {
      // Degenerate (tangent ≈ +Y).  Use +X as fallback.
      outward = [1, 0, 0];
      mag = 1;
    }
    outward = [outward[0] / mag, outward[1] / mag, outward[2] / mag];

    const emitted = emitResidueAtoms(base, "RNA", {
      c1Pos: entry.pos,
      tangent: t,
      outward,
      twist: 0, // RNA path is irregular — no helical twist applies
    });
    const { atoms, nameToSerial } = emittedToAtoms(
      emitted,
      base.toUpperCase(),
      k + 1,
      chainAt,
      serial,
      base,
      "RNA",
    );
    serial += atoms.length;
    const pSerial = nameToSerial.get("P");
    const prev = prevO3[chainAt];
    if (prev !== null && pSerial !== undefined) {
      const pAtom = atoms.find(a => a.serial === pSerial);
      const prevO3Atom = all.find(a => a.serial === prev);
      if (pAtom) {
        pAtom.bonds = [...(pAtom.bonds ?? []), prev];
        pAtom.bondOrder = [...(pAtom.bondOrder ?? []), 1];
      }
      if (prevO3Atom) {
        prevO3Atom.bonds = [...(prevO3Atom.bonds ?? []), pSerial];
        prevO3Atom.bondOrder = [...(prevO3Atom.bondOrder ?? []), 1];
      }
    }
    prevO3[chainAt] = nameToSerial.get("O3'") ?? null;
    all.push(...atoms);
  }
  return { atoms: all, nextSerial: serial };
}

class AtomicBuilder implements GeometryBuilder {
  readonly mode = "atomic" as const;
  private readonly base = createSchematicBuilder();

  build(
    manifest: SimulationManifest,
    snapshot: Snapshot,
    options: RenderOptions,
  ): GeometryFrame {
    const frame = this.base.build(manifest, snapshot, options);

    // In overall-atomic mode strip the procedural protein chains; the
    // 6ALF cartoon supplies them.  Atomic-mode STRAND atoms (chain
    // A_at/B_at/R_at/T_at/H_at/U_at) are no longer appended here —
    // they live in a separate model loaded via the PDB parser path
    // (see `emitAtomicPdbText` + `atomicModelRef` in Viewer3D.tsx).
    // This keeps the dynamic model lean (just band/schematic atoms)
    // and lets 3Dmol's nucleic-acid bond template draw clean rings
    // on the atomic chains.
    const filtered = frame.atoms.filter(
      (a) => !PROCEDURAL_PROTEIN_CHAINS.has(a.chain),
    );
    return { atoms: filtered, hints: frame.hints, labels: frame.labels };
  }
}

export function createAtomicBuilder(): GeometryBuilder {
  return new AtomicBuilder();
}

/* ------------------------------------------------------------------ */
/* Schematic-mode atomic emission                                      */
/* ------------------------------------------------------------------ */

/**
 * In schematic overall mode, the user can still pick `atomic` for an
 * individual strand (e.g. "RNA = atomic, everything else schematic").
 * The schematic builder doesn't know about atomic templates, so the
 * Viewer3D layer post-processes its frame by appending atomic atoms
 * computed from the same StrandFrame the schematic just used.
 *
 * Returns the new atom array (does not mutate `frame.atoms`).
 */
export function augmentSchematicWithAtomic(
  frame: GeometryFrame,
  manifest: SimulationManifest,
  snapshot: Snapshot,
  options: RenderOptions,
): GeometryFrame {
  const flags = atomicStrandFlags(options);
  if (!flags.coding && !flags.template && !flags.rna) {
    return frame;
  }
  const sf = computeStrandFrame(manifest, snapshot, options);
  let nextSerial = frame.atoms.reduce((m, a) => Math.max(m, a.serial), 0) + 1;
  const codingSeq = manifest.sequence.coding_strand;
  const templateSeq = manifest.sequence.template_strand;
  const lenSeq = codingSeq.length;
  const newAtoms: Atom[] = [];

  if (flags.coding) {
    const resnames = sf.backbone.map((pt) => codingSeq[pt.idx] ?? "A");
    const r = emitStrand(
      "A", "A_at",
      sf.backbone, resnames, +1,
      "strandTangentCoding",
      sf.bubbleLoIdx, sf.bubbleHiIdx,
      "DNA",
      nextSerial,
    );
    nextSerial = r.nextSerial;
    newAtoms.push(...r.atoms);
  }
  if (flags.template) {
    const resnames = sf.backbone.map((pt) =>
      templateSeq[lenSeq - 1 - pt.idx] ?? "A",
    );
    const r = emitStrand(
      "B", "B_at",
      sf.backbone, resnames, -1,
      "strandTangentTemplate",
      sf.bubbleLoIdx, sf.bubbleHiIdx,
      "DNA",
      nextSerial,
    );
    nextSerial = r.nextSerial;
    newAtoms.push(...r.atoms);
  }
  if (flags.rna && sf.rnaPositions.length > 0) {
    const r = emitRna(
      sf.rnaPositions,
      snapshot.rna_sequence,
      nextSerial,
    );
    nextSerial = r.nextSerial;
    newAtoms.push(...r.atoms);
  }

  return {
    atoms: [...frame.atoms, ...newAtoms],
    hints: frame.hints,
    labels: frame.labels,
  };
}

/* ------------------------------------------------------------------ */
/* PDB-text emission for atomic chains                                 */
/* ------------------------------------------------------------------ */

/**
 * Emit atomic-chain atoms as PDB-format text suitable for
 * `viewer.addModel(pdbText, "pdb")`.
 *
 * Why PDB text instead of `addAtoms`: 3Dmol's PDB parser triggers
 * its standard nucleic-acid bond-assignment logic (using internal
 * residue templates), which produces clean pentagonal sugar rings
 * and proper aromatic base rings.  Direct `addAtoms` skips that
 * step — even with explicit `bonds` arrays we end up with either
 * incorrect ring bonds or no bonds at all (verified empirically
 * via the test page at `/atomic_test.html`).
 *
 * Returned PDB uses single-character chain IDs (A/B/R/T/H/U) per
 * the PDB ATOM record column constraint.  These collide with
 * the schematic's band-chain IDs but are namespaced because the
 * caller loads them into a SEPARATE 3Dmol model (see
 * `atomicModelRef` in Viewer3D.tsx).
 *
 * Phantom 3' residue (chainResi=N+1) is emitted on each strand so
 * 3Dmol's cartoon style — which trims the last residue of each
 * chain from its trace — drops the phantom instead of a real
 * residue.  Same trick we used for the addAtoms path.
 *
 * Returns `{ pdbText: "", rnaResiRanges: [] }` when no strand pick is
 * `"atomic"`; the caller skips the addModel call when pdbText is empty.
 *
 * `rnaResiRanges` lists one entry per contiguous run of each schematic
 * RNA section (T/R/H/U) so Viewer3D can apply per-section colours via
 * `setStyle({chain:"R", resi:[...]}, ...)` after loading the model.
 */
export function emitAtomicPdbText(
  manifest: SimulationManifest,
  snapshot: Snapshot,
  options: RenderOptions,
): { pdbText: string; rnaResiRanges: RnaResiRange[] } {
  const flags = atomicStrandFlags(options);
  if (!flags.coding && !flags.template && !flags.rna) {
    return { pdbText: "", rnaResiRanges: [] };
  }
  const sf = computeStrandFrame(manifest, snapshot, options);
  const lines: string[] = [];
  let serial = 1;
  const codingSeq = manifest.sequence.coding_strand;
  const templateSeq = manifest.sequence.template_strand;
  const lenSeq = codingSeq.length;

  if (flags.coding) {
    const resnames = sf.backbone.map((pt) => codingSeq[pt.idx] ?? "A");
    serial = emitStrandPdb(
      "A", sf.backbone, resnames, +1,
      "strandTangentCoding",
      sf.bubbleLoIdx, sf.bubbleHiIdx,
      "DNA",
      serial, lines,
    );
  }
  if (flags.template) {
    const resnames = sf.backbone.map((pt) =>
      templateSeq[lenSeq - 1 - pt.idx] ?? "A",
    );
    serial = emitStrandPdb(
      "B", sf.backbone, resnames, -1,
      "strandTangentTemplate",
      sf.bubbleLoIdx, sf.bubbleHiIdx,
      "DNA",
      serial, lines,
    );
  }

  let rnaResiRanges: RnaResiRange[] = [];
  if (flags.rna && sf.rnaPositions.length > 0) {
    const result = emitRnaPdb(sf.rnaPositions, snapshot.rna_sequence, serial, lines);
    serial = result.nextSerial;
    rnaResiRanges = result.resiRanges;
  }

  lines.push("END");
  return { pdbText: lines.join("\n"), rnaResiRanges };
}

/**
 * Walk a DNA strand and emit one residue's atoms per base as PDB
 * ATOM records.  Mirrors `emitStrand`: same C1' override for
 * template, same axis-relative outward, same phantom 3' residue.
 * The differences are (1) output is text lines instead of `Atom[]`
 * and (2) we don't thread bonds — 3Dmol's PDB parser applies its
 * internal residue template instead.
 *
 * Returns the next free serial number after emission.
 */
function emitStrandPdb(
  chainAt: string,
  backbone: BaseAxisPointPub[],
  resnames: string[],
  strandSign: 1 | -1,
  tangentField: "strandTangentCoding" | "strandTangentTemplate",
  bubbleLoIdx: number,
  bubbleHiIdx: number,
  kind: ResidueKind,
  startSerial: number,
  outLines: string[],
): number {
  let serial = startSerial;
  const reverseIter = strandSign === -1;
  const indices: number[] = reverseIter
    ? Array.from({ length: backbone.length }, (_, k) => backbone.length - 1 - k)
    : Array.from({ length: backbone.length }, (_, k) => k);
  let chainResi = 0;
  for (const i of indices) {
    chainResi++;
    const pt = backbone[i];
    let c1: [number, number, number];
    const inBubble = pt.idx >= bubbleLoIdx && pt.idx <= bubbleHiIdx;
    if (strandSign === 1 || inBubble) {
      c1 = strandScenePosition(pt, strandSign, bubbleLoIdx, bubbleHiIdx);
    } else {
      const phase = pt.twist - SCHEMATIC_TWIST_PER_BP + TEMPLATE_PAIRING_OFFSET_RAD;
      const R = SCHEMATIC_HELIX_RADIUS;
      c1 = [
        pt.axis[0] + R * Math.cos(phase),
        pt.axis[1] + R * Math.sin(phase),
        pt.axis[2],
      ];
    }
    const tangent = pt[tangentField];
    const radial: [number, number, number] = [
      c1[0] - pt.axis[0], c1[1] - pt.axis[1], c1[2] - pt.axis[2],
    ];
    const dotRT = radial[0] * tangent[0] + radial[1] * tangent[1] + radial[2] * tangent[2];
    let outward: [number, number, number] = [
      radial[0] - dotRT * tangent[0],
      radial[1] - dotRT * tangent[1],
      radial[2] - dotRT * tangent[2],
    ];
    let mag = Math.hypot(outward[0], outward[1], outward[2]);
    if (mag < 1e-6) { outward = [0, 1, 0]; mag = 1; }
    outward = [outward[0] / mag, outward[1] / mag, outward[2] / mag];

    const baseChar = resnames[i] ?? "A";
    const emitted = emitResidueAtoms(baseChar, kind, {
      c1Pos: c1, tangent, outward, twist: 0,
    });
    const resn = kind === "DNA"
      ? `D${baseChar[0].toUpperCase()}`
      : baseChar.toUpperCase();
    for (const a of emitted) {
      outLines.push(formatPdbAtom(serial, a.name, resn, chainAt, chainResi, a.pos[0], a.pos[1], a.pos[2], a.elem));
      serial++;
    }
  }

  // Phantom 3' residue — 3Dmol's cartoon trims the last residue per
  // chain.  Without this, the actual N-th real base would not get a
  // base block in the cartoon ribbon.
  if (indices.length > 0) {
    const lastRenderIdx = indices[indices.length - 1];
    const lastPt = backbone[lastRenderIdx];
    chainResi++;
    const phantomTwist = lastPt.twist + (strandSign === 1 ? +SCHEMATIC_TWIST_PER_BP : -SCHEMATIC_TWIST_PER_BP);
    const phantomZ = lastPt.axis[2] + (strandSign === 1 ? +SCHEMATIC_RISE_PER_BP : -SCHEMATIC_RISE_PER_BP);
    const R = SCHEMATIC_HELIX_RADIUS;
    const phantomPhase = strandSign === 1
      ? phantomTwist
      : phantomTwist + TEMPLATE_PAIRING_OFFSET_RAD;
    const phantomC1: [number, number, number] = [
      lastPt.axis[0] + R * Math.cos(phantomPhase),
      lastPt.axis[1] + R * Math.sin(phantomPhase),
      phantomZ,
    ];
    const phantomTangent: [number, number, number] = strandSign === 1 ? [0, 0, 1] : [0, 0, -1];
    const phantomOutward: [number, number, number] = [
      Math.cos(phantomPhase), Math.sin(phantomPhase), 0,
    ];
    const phantomBase = resnames[lastRenderIdx] ?? "A";
    const phantomEmitted = emitResidueAtoms(phantomBase, kind, {
      c1Pos: phantomC1, tangent: phantomTangent, outward: phantomOutward, twist: 0,
    });
    const phantomResn = kind === "DNA"
      ? `D${phantomBase[0].toUpperCase()}`
      : phantomBase.toUpperCase();
    for (const a of phantomEmitted) {
      outLines.push(formatPdbAtom(serial, a.name, phantomResn, chainAt, chainResi, a.pos[0], a.pos[1], a.pos[2], a.elem));
      serial++;
    }
  }
  return serial;
}

/**
 * Describes one contiguous section of the nascent RNA as emitted into
 * the unified PDB chain.  The `chainId` is the original schematic chain
 * identifier (T = hybrid/trapped, R = exit thread, H = hairpin, U =
 * U-tract) and is used by Viewer3D to apply the matching section colour
 * via a per-resi-range `setStyle` call.
 */
export interface RnaResiRange {
  /** Original schematic chain identifier — drives section colour. */
  chainId: "T" | "R" | "H" | "U";
  /** First residue number in this section (1-based, inclusive). */
  startResi: number;
  /** Last residue number in this section (1-based, inclusive). */
  endResi: number;
}

/**
 * RNA per-base PDB emission.  ALL RNA residues — regardless of their
 * schematic chain (T/R/H/U) — are now emitted onto the SINGLE PDB
 * chain "R" with globally-sequential residue numbers (k + 1 for base
 * index k).  This gives 3Dmol a single unbroken chain to trace as a
 * cartoon ribbon, joining the hybrid, exit-thread, hairpin, and
 * U-tract sections into one continuous strand.
 *
 * Per-section colours are applied in Viewer3D via `setStyle` scoped to
 * the resi ranges returned here — one range per run of the same
 * schematic chain type.
 *
 * No phantom emission for the RNA chain — residue counts vary
 * per-frame and a phantom would visually clutter the exit thread /
 * hairpin.  The cartoon trim of the very last residue is acceptable
 * since RNA cartoon visibility is primarily carried by the continuous
 * ribbon through the other residues.
 */
function emitRnaPdb(
  rnaPositions: RnaBasePosPub[],
  rnaSeq: string,
  startSerial: number,
  outLines: string[],
): { nextSerial: number; resiRanges: RnaResiRange[] } {
  const VALID_CHAINS = new Set(["T", "R", "H", "U"]);
  let serial = startSerial;
  const resiRanges: RnaResiRange[] = [];
  let currentChainId: "T" | "R" | "H" | "U" | null = null;
  let currentRangeStart = 1;

  for (let k = 0; k < rnaPositions.length; k++) {
    const entry = rnaPositions[k];
    const originalChain = entry.chain;
    if (!VALID_CHAINS.has(originalChain)) continue;
    const sectionChain = originalChain as "T" | "R" | "H" | "U";

    // Global sequential resi — makes 3Dmol trace a continuous ribbon
    // across all sections on the single chain "R".
    const globalResi = k + 1;

    // Track transitions between schematic sections for the resi range table.
    if (sectionChain !== currentChainId) {
      if (currentChainId !== null) {
        resiRanges.push({
          chainId: currentChainId,
          startResi: currentRangeStart,
          endResi: globalResi - 1,
        });
      }
      currentChainId = sectionChain;
      currentRangeStart = globalResi;
    }

    const base = rnaSeq[k] ?? "A";
    const t = entry.tangent;
    const upY: [number, number, number] = [0, 1, 0];
    const dot = t[0] * upY[0] + t[1] * upY[1] + t[2] * upY[2];
    let outward: [number, number, number] = [
      upY[0] - dot * t[0], upY[1] - dot * t[1], upY[2] - dot * t[2],
    ];
    let mag = Math.hypot(outward[0], outward[1], outward[2]);
    if (mag < 0.1) { outward = [1, 0, 0]; mag = 1; }
    outward = [outward[0] / mag, outward[1] / mag, outward[2] / mag];

    const emitted = emitResidueAtoms(base, "RNA", {
      c1Pos: entry.pos, tangent: t, outward, twist: 0,
    });
    const resn = base.toUpperCase();
    // All RNA residues go onto the single unified PDB chain "R".
    for (const a of emitted) {
      outLines.push(formatPdbAtom(serial, a.name, resn, "R", globalResi, a.pos[0], a.pos[1], a.pos[2], a.elem));
      serial++;
    }
  }

  // Close the final range.
  if (currentChainId !== null) {
    resiRanges.push({
      chainId: currentChainId,
      startResi: currentRangeStart,
      endResi: rnaPositions.length,
    });
  }

  return { nextSerial: serial, resiRanges };
}

/**
 * Format one PDB ATOM record.  Column-precise — 3Dmol's parser uses
 * fixed-width PDB column positions so off-by-one column shifts will
 * cause silent mis-parsing.
 *
 * PDB ATOM record (standard v3.30):
 *   Cols  1- 6: "ATOM  "
 *   Cols  7-11: serial (right-aligned)
 *   Col  12   : space
 *   Cols 13-16: atom name (4-char names left-aligned at col 13;
 *               1-3 char names start at col 14 with a leading space
 *               at col 13 — convention helps disambiguate elements
 *               like CA-the-alpha-C from CA-the-calcium)
 *   Col  17   : altLoc indicator (' ')
 *   Cols 18-20: residue name (left-aligned)
 *   Col  21   : space
 *   Col  22   : chain ID
 *   Cols 23-26: resi (right-aligned)
 *   Col  27   : iCode (' ')
 *   Cols 28-30: spaces
 *   Cols 31-38: x (8-char fixed, 3 decimals)
 *   Cols 39-46: y
 *   Cols 47-54: z
 *   Cols 55-60: occupancy ("  1.00")
 *   Cols 61-66: temp factor / B-factor ("  0.00")
 *   Cols 67-76: spaces (segment ID at 73-76 sometimes — we leave blank)
 *   Cols 77-78: element symbol (right-aligned)
 */
function formatPdbAtom(
  serial: number,
  atomName: string,
  resn: string,
  chain: string,
  resi: number,
  x: number, y: number, z: number,
  elem: string,
): string {
  // Atom name column rule: 4-char names occupy cols 13-16; shorter
  // names start at col 14 (leading space at col 13).
  const nameField = atomName.length >= 4
    ? atomName.slice(0, 4)
    : ` ${atomName}`.padEnd(4);
  return (
    "ATOM  " +
    String(serial).padStart(5) +
    " " +
    nameField +
    " " +                       // altLoc
    resn.padEnd(3) +
    " " +
    (chain || " ").charAt(0) +
    String(resi).padStart(4) +
    "    " +                    // iCode + spaces (cols 27-30)
    x.toFixed(3).padStart(8) +
    y.toFixed(3).padStart(8) +
    z.toFixed(3).padStart(8) +
    "  1.00" +                  // occupancy
    "  0.00" +                  // temp factor
    "          " +              // padding to col 76
    elem.padStart(2)
  );
}

/** Atomic-mode chain IDs (single-char as per PDB ATOM record). */
export const ATOMIC_CHAINS = {
  CODING: "A",
  TEMPLATE: "B",
  RNA_EXIT: "R",
  RNA_HYBRID: "T",
  RNA_HAIRPIN: "H",
  RNA_UTRACT: "U",
} as const;
