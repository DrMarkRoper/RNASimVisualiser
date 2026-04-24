/**
 * Atomic renderer.
 *
 * Emits the same *dynamic* geometry as the schematic builder (DNA strands,
 * transcription bubble, W433 intercalation, nascent RNA, backtracked RNA)
 * but *omits* the RNAP placeholder (chain P) and the procedural σ⁷⁰
 * cartoon (chain S).  Those are supplied by the PDB model that Viewer3D
 * loads from RCSB (6ALF — E. coli RNAP holoenzyme open complex) when this
 * mode is active.
 *
 * The sigma70Presence hint still flows through so Viewer3D can fade the
 * PDB's σ chain on promoter escape.
 */
import type { GeometryBuilder, GeometryFrame } from "./types";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import { createSchematicBuilder } from "./schematic";

class AtomicBuilder implements GeometryBuilder {
  readonly mode = "atomic" as const;
  private readonly base = createSchematicBuilder();

  build(manifest: SimulationManifest, snapshot: Snapshot): GeometryFrame {
    const frame = this.base.build(manifest, snapshot);
    // Drop RNAP (P) and procedural σ⁷⁰ (S) — the PDB model provides them.
    const atoms = frame.atoms.filter((a) => a.chain !== "P" && a.chain !== "S");
    return { atoms, hints: frame.hints };
  }
}

export function createAtomicBuilder(): GeometryBuilder {
  return new AtomicBuilder();
}
