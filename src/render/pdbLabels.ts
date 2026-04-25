/**
 * Hover labels for the atomic-mode PDB (6ALF).
 *
 * In atomic mode we register a single 3Dmol `setHoverable` call on the
 * PDB model and use this lookup to decide what label to pop up for the
 * atom currently under the cursor.
 *
 * Residue ranges for σ⁷⁰ (chain F) follow the canonical E. coli σ⁷⁰
 * (RpoD, 613 aa) numbering.  Region 1.1 (res 1–93) is intrinsically
 * disordered and is not resolved in the 6ALF entry; the selector for
 * the resolved part starts at ~94.  Numbering inside 6ALF matches the
 * canonical sequence — re-check this if RCSB issues a re-numbered
 * revision.
 */

/** Narrow shape of the 3Dmol `AtomSpec` that the hover callback sees. */
export interface PdbHoverAtom {
  chain?: string;
  resi?: number;
}

/**
 * Hover label for an atom in the *schematic* (procedural) dynamic model.
 *
 * Chain conventions in schematic.ts:
 *   A — coding-strand DNA spheres
 *   B — template-strand DNA spheres
 *   R — nascent RNA spheres
 *   X — backtracked RNA spheres
 *   P — RNAP body (two big grey blobs)
 *   W — W433 indole (10-atom indole ring)
 *   S — σ⁷⁰ four-domain cartoon (resi 1..4 = s4 / s3 / s2 / s1.1)
 *
 * The PDB and schematic chain alphabets overlap (A/B), so we cannot reuse
 * `getPdbHoverLabel` for the dynamic model — chain "A" means α-subunit in
 * 6ALF but coding-strand DNA in the schematic.
 */
export function getSchematicHoverLabel(atom: PdbHoverAtom): string | null {
  const { chain, resi } = atom;
  switch (chain) {
    case "P":
      return "RNA polymerase (RNAP)";
    case "S":
      // σ⁷⁰ domains land at resi 1..4 in build order (see SIGMA_DOMAINS in
      // render/schematic.ts).  Default falls back to the bare σ⁷⁰ label so
      // a hover on a connecting line segment without a numeric resi still
      // resolves to something meaningful.
      switch (resi) {
        case 1: return "σ⁷⁰ Region 4 — −35 hexamer recognition";
        case 2: return "σ⁷⁰ Region 3 — spacer / promoter contact";
        case 3: return "σ⁷⁰ Region 2 — −10 melt / hexamer recognition";
        case 4: return "σ⁷⁰ Region 1.1 — main channel";
        default: return "σ⁷⁰";
      }
    case "W":
      return "Trp433 — σ⁷⁰ region 2.3 melt wedge";
    case "A":
      return "Coding (non-template) strand";
    case "B":
      return "Template strand";
    case "R":
      return "Nascent RNA";
    case "T":
      return "Trapped RNA — σ1.1 blocks exit channel while σ⁷⁰ is bound (abortive release likely)";
    case "X":
      return "Backtracked RNA (secondary channel)";
    default:
      return null;
  }
}

/**
 * Resolve the label to show for a hovered PDB atom.  Returns null when
 * the atom doesn't belong to a labelled chain (e.g. solvent, ligands
 * we don't annotate) so the caller can skip opening a tooltip.
 */
export function getPdbHoverLabel(atom: PdbHoverAtom): string | null {
  const { chain, resi } = atom;

  // σ⁷⁰ (chain F) — split into the four conserved regions.  Ranges are
  // deliberately coarse so a hover anywhere inside a domain works; the
  // region boundaries are approximate and not all residues fall neatly
  // into one bucket (e.g. the 2.1–2.2 core-binding surface blurs into
  // the 2.3 melt wedge).
  if (chain === "F") {
    if (typeof resi !== "number") return "σ⁷⁰";
    if (resi <= 137) return "σ⁷⁰ Region 1.2 — DNA-mimic, clamp latch";
    if (resi <= 362) return "σ⁷⁰ NCR — region-1.2↔2.1 linker";
    if (resi <= 410) return "σ⁷⁰ Region 2.1–2.2 — core RNAP binding";
    if (resi <= 437) return "σ⁷⁰ Region 2.3 — −10 DNA melting (W433 wedge)";
    if (resi <= 448) return "σ⁷⁰ Region 2.4 — −10 hexamer recognition";
    if (resi <= 528) return "σ⁷⁰ Region 3 — −10 extension & σ-finger";
    return "σ⁷⁰ Region 4 — −35 hexamer recognition";
  }

  // RNAP core — labels at the subunit level.  The two big "lobes" the
  // user usually asks about are β (chain C, downstream clamp + protrusion)
  // and β′ (chain D, clamp + jaw, Mg²⁺ active site).
  switch (chain) {
    case "A": return "RNAP α subunit (αI) — assembly / UP-element contact";
    case "B": return "RNAP α subunit (αII) — assembly / UP-element contact";
    case "C": return "RNAP β subunit — lobe & protrusion (downstream DNA clamp)";
    case "D": return "RNAP β′ subunit — clamp, jaw, Mg²⁺ active site";
    case "E": return "RNAP ω subunit — β′ folding chaperone";
    default:  return null;
  }
}
