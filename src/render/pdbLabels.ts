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
 *   T — trapped RNA (σ-blocked)
 *   W — W433 indole (10-atom indole ring)
 *
 *   P — legacy RNAP placeholder (rendered when options.rnap === "schematic")
 *   Y — RNAP α subunit I       (RpoA1, assembly platform)         ┐
 *   Z — RNAP α subunit II      (RpoA2, assembly platform)         │
 *   Q — RNAP β subunit         (RpoB, lobe + flap)                ├ rendered
 *   K — RNAP β′ subunit        (RpoC, clamp + Mg²⁺ active site)   │ when
 *   O — RNAP ω subunit         (RpoZ, β′ folding chaperone)       ┘ options.rnap === "mesh"
 *
 *   S — σ⁷⁰ legacy four-domain blob (resi 1..4 = s4 / s3 / s2 / s11)
 *       rendered when options.sigma === "schematic".
 *   M — σ⁷⁰ four-region mesh (resi 1..6, see SIGMA_ATOMS) rendered when
 *       options.sigma === "mesh".  Single rigid body — atoms move
 *       together via SIGMA_APPROACH_OFFSET / SIGMA_RELEASE_OFFSET.
 *
 * The PDB and schematic chain alphabets overlap (A/B), so we cannot reuse
 * `getPdbHoverLabel` for the dynamic model — chain "A" means α-subunit in
 * 6ALF but coding-strand DNA in the schematic.
 */
export function getSchematicHoverLabel(atom: PdbHoverAtom): string | null {
  const { chain, resi } = atom;
  switch (chain) {
    // -- RNAP subunits (mesh mode) ------------------------------------------
    case "Y": return "RNAP α subunit I — RpoA1, assembly platform / αCTD UP-element contact";
    case "Z": return "RNAP α subunit II — RpoA2, assembly platform / αCTD UP-element contact";
    case "Q": return "RNAP β subunit — lobe & protrusion (upper cleft jaw)";
    case "K": return "RNAP β′ subunit — clamp, bridge helix, Mg²⁺ active site";
    case "O": return "RNAP ω subunit — β′ folding chaperone";

    // -- RNAP legacy two-blob placeholder (schematic mode) ------------------
    case "P": return "RNA polymerase (RNAP)";

    // -- σ⁷⁰ legacy four-domain blob (schematic mode) -----------------------
    case "S":
      switch (resi) {
        case 1: return "σ⁷⁰ Region 4 — −35 hexamer recognition";
        case 2: return "σ⁷⁰ Region 3 — spacer / promoter contact";
        case 3: return "σ⁷⁰ Region 2 — −10 melt / hexamer recognition";
        case 4: return "σ⁷⁰ Region 1.1 — main channel";
        default: return "σ⁷⁰";
      }

    // -- σ⁷⁰ four-region mesh (mesh mode, resi 1..6 from SIGMA_ATOMS) -------
    case "M":
      switch (resi) {
        case 1:
        case 2:
          return "σ⁷⁰ Region 4 — −35 hexamer recognition (HTH motif)";
        case 3:
          return "σ⁷⁰ Region 3 — spacer / extended-10 contacts";
        case 4:
          return "σ⁷⁰ Region 2.4 — −10 hexamer recognition";
        case 5:
          return "σ⁷⁰ Region 2.3 — −10 DNA melting (W433 wedge anchor)";
        case 6:
          return "σ⁷⁰ Region 1.1 — autoinhibitory NTD, occludes the main channel";
        default:
          return "σ⁷⁰";
      }

    // -- Other dynamic-model elements ---------------------------------------
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
