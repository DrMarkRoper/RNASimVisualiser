/**
 * Atomic renderer.
 *
 * Emits the same *dynamic* geometry as the schematic builder (DNA strands,
 * transcription bubble, W433 intercalation, nascent RNA, backtracked RNA)
 * but *omits* the procedural RNAP body and σ⁷⁰ cartoon — those are supplied
 * by the PDB model that Viewer3D loads from RCSB (6ALF — E. coli RNAP
 * holoenzyme open complex) when this mode is active.
 *
 * The sigma70Presence hint still flows through so Viewer3D can fade the
 * PDB's σ chain on promoter escape.  Labels (RNAP subunit / σ region names)
 * are also dropped — atomic mode relies on hover labels off the PDB cartoon
 * instead of on-canvas text.
 */
import type { GeometryBuilder, GeometryFrame } from "./types";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { RenderOptions } from "../components/RenderOptionsButton";
import { createSchematicBuilder } from "./schematic";

/** Procedural RNAP / σ chains that must be hidden when the PDB cartoon is
 *  loaded — otherwise the schematic mesh duplicates the 6ALF subunits.
 *  Includes the legacy "P" placeholder, σ⁷⁰ chains "S" (legacy four-domain)
 *  and "M" (new four-region mesh), plus the five per-subunit chains added
 *  by the RNAP mesh refactor. */
const PROCEDURAL_PROTEIN_CHAINS = new Set(["P", "S", "M", "Y", "Z", "Q", "K", "O"]);

class AtomicBuilder implements GeometryBuilder {
  readonly mode = "atomic" as const;
  private readonly base = createSchematicBuilder();

  build(
    manifest: SimulationManifest,
    snapshot: Snapshot,
    options: RenderOptions,
  ): GeometryFrame {
    const frame = this.base.build(manifest, snapshot, options);
    // Drop the procedural RNAP body (P + per-subunit chains) and σ⁷⁰
    // (S legacy + M mesh).  The 6ALF cartoon supplies them in atomic mode.
    const atoms = frame.atoms.filter((a) => !PROCEDURAL_PROTEIN_CHAINS.has(a.chain));
    return { atoms, hints: frame.hints };
  }
}

export function createAtomicBuilder(): GeometryBuilder {
  return new AtomicBuilder();
}
