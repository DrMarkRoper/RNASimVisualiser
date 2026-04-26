import type { Phase } from "../types/manifest";

/**
 * Canonical colour per simulation phase.
 * Used by the timeline band, phase chip, and 3D scene hints.
 *
 * Chosen to be colour-blind friendly (Okabe-Ito palette, loosely).
 */
export const PHASE_COLORS: Record<Phase, string> = {
  approaching:  "#a78bfa", // violet   — σ+RNAP assembling & descending to DNA
  initiation:   "#56B4E9", // sky blue — closed complex on promoter
  open_complex: "#0072B2", // deep blue — W433 intercalated, bubble open
  scrunching:   "#F0E442", // yellow   — DNA scrunching, abortive-prone
  elongation:   "#009E73", // green    — productive synthesis
  paused:       "#E69F00", // orange   — elemental pause
  backtracked:  "#D55E00", // red      — displaced 3′ end
  terminated:   "#999999", // grey     — transcript released
  detaching:    "#c4b5fd", // light violet — RNAP lifting off, bubble closing
  aborted:      "#CC79A7", // magenta  — abortive/arrested release
};

export const PHASE_LABEL: Record<Phase, string> = {
  approaching:  "Approaching",
  initiation:   "Initiation",
  open_complex: "Open complex",
  scrunching:   "Scrunching",
  elongation:   "Elongation",
  paused:       "Paused",
  backtracked:  "Backtracked",
  terminated:   "Terminated",
  detaching:    "Detaching",
  aborted:      "Aborted",
};
