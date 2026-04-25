/**
 * TypeScript mirror of rnasim.snapshot.SimulationManifest.
 *
 * The Python engine is the source of truth — this file should be updated
 * whenever `snapshot.py::SimulationManifest.to_dict` changes.
 *
 * A zod schema is colocated to validate untrusted JSON at the loader boundary.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Phase                                                              */
/* ------------------------------------------------------------------ */

export const PHASES = [
  "approaching",   // σ+core assembling & holoenzyme descending to promoter
  "initiation",
  "open_complex",
  "scrunching",
  "elongation",
  "paused",
  "backtracked",
  "terminated",
  "detaching",     // RNAP lifting off, bubble collapsing, RNA releasing
  "aborted",
] as const;

export type Phase = (typeof PHASES)[number];

export const PhaseSchema = z.enum(PHASES);

/* ------------------------------------------------------------------ */
/* Snapshot                                                           */
/* ------------------------------------------------------------------ */

export const SnapshotSchema = z.object({
  frame: z.number().int().nonnegative(),
  time_s: z.number().nonnegative(),
  phase: PhaseSchema,

  position: z.number().int(),
  bubble_upstream: z.number().int(),
  bubble_downstream: z.number().int(),
  scrunch_nt: z.number().int().nonnegative(),

  w433_depth: z.number().min(0).max(1),

  rna_sequence: z.string(),
  backtrack_steps: z.number().int().nonnegative(),
  is_arrested: z.boolean(),
  greb_active: z.boolean(),

  rnap_tss: z.number().int(),

  events: z.array(z.string()).default([]),

  // Derived convenience fields Python adds to the JSON.
  bubble_size: z.number().int().nonnegative(),
  rna_length: z.number().int().nonnegative(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

/* ------------------------------------------------------------------ */
/* Metadata / sequence / promoter / params                            */
/* ------------------------------------------------------------------ */

export const MetadataSchema = z.object({
  sequence_name: z.string(),
  created_at: z.string(),
  random_seed: z.number().int().nullable(),
  total_frames: z.number().int().nonnegative(),
  total_time_s: z.number().nonnegative(),
  final_rna_length: z.number().int().nonnegative(),
  final_phase: z.string(),
});

export const SequenceSchema = z.object({
  coding_strand: z.string().regex(/^[ACGTN]+$/i),
  template_strand: z.string().regex(/^[ACGTN]+$/i),
  tss_index: z.number().int().nonnegative(),
  sequence_length: z.number().int().positive(),
});

export const PromoterSchema = z.object({
  tss: z.number().int(),
  pos_35: z.number().int(),
  pos_10: z.number().int(),
  hexamer_35: z.string(),
  hexamer_10: z.string(),
  spacer_len: z.number().int(),
  promoter_score: z.number().min(0).max(1),
  w433_contacts: z.string().length(2),
  extended_minus10: z.boolean(),
});

export const ParamsSchema = z.object({
  // Tier 1 — control parameters
  temperature_c: z.number(),
  ntp_conc_uM: z.record(z.string(), z.number()),
  greb_conc_uM: z.number().nonnegative(),
  rho_enabled: z.boolean(),
  // Tier 2 — advanced / comparative parameters
  // .optional() + .default() keeps older snapshots.json files loading cleanly.
  k_cat: z.number().positive().optional().default(50.0),
  p_abortive_base: z.number().min(0).max(1).optional().default(0.6),
  abortive_decay: z.number().nonnegative().optional().default(0.18),
  hairpin_dg_threshold: z.number().optional().default(-3.0),
  escape_length: z.number().int().positive().optional().default(11),
});

/* ------------------------------------------------------------------ */
/* Terminator annotation (optional)                                    */
/* ------------------------------------------------------------------ */

/**
 * Post-hoc annotation of an intrinsic terminator detected on the final
 * RNA.  All *_start / *_end fields are 0-based RNA indices, with *_end
 * exclusive (Python slice convention).  The SequencePanel translates
 * them to coding-strand DNA columns via `tss_index + rna_idx`.
 *
 * `u_tract_start == u_tract_end == 0` means no qualifying U-tract was
 * detected downstream of the stem — the stem is still shown.
 */
export const TerminatorSchema = z.object({
  hairpin_dg:       z.number(),
  stem5_start:      z.number().int().nonnegative(),
  stem5_end:        z.number().int().nonnegative(),
  loop_start:       z.number().int().nonnegative(),
  loop_end:         z.number().int().nonnegative(),
  stem3_start:      z.number().int().nonnegative(),
  stem3_end:        z.number().int().nonnegative(),
  stem_len:         z.number().int().nonnegative(),
  loop_len:         z.number().int().nonnegative(),
  u_tract_start:    z.number().int().nonnegative(),
  u_tract_end:      z.number().int().nonnegative(),
  u_tract_fraction: z.number().min(0).max(1),
});

export type TerminatorInfo = z.infer<typeof TerminatorSchema>;

/* ------------------------------------------------------------------ */
/* Top-level manifest                                                 */
/* ------------------------------------------------------------------ */

export const SimulationManifestSchema = z.object({
  // Provenance marker written by Python's SimulationManifest.to_dict.
  // Kept optional so older snapshots.json files (pre-tag) still load, but
  // the Load Simulation File dialog refuses blobs whose application
  // field is present *and* not "RNASim" — and requires it for files
  // dropped in by the user (stricter than defaults because we're opening
  // arbitrary user input).
  application: z.literal("RNASim").optional(),
  version: z.string(),
  metadata: MetadataSchema,
  sequence: SequenceSchema,
  promoter: PromoterSchema,
  params: ParamsSchema,
  snapshots: z.array(SnapshotSchema).min(1),
  terminator: TerminatorSchema.optional(),
});

export type SimulationManifest = z.infer<typeof SimulationManifestSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type SequenceInfo = z.infer<typeof SequenceSchema>;
export type PromoterInfo = z.infer<typeof PromoterSchema>;
export type KineticParamsInfo = z.infer<typeof ParamsSchema>;

/* ------------------------------------------------------------------ */
/* Parse helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse a raw JSON blob into a validated SimulationManifest.
 * Throws a ZodError (with .issues) on schema mismatch.
 */
export function parseManifest(raw: unknown): SimulationManifest {
  return SimulationManifestSchema.parse(raw);
}
