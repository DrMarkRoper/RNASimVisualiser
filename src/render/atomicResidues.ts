/**
 * Per-residue atom-template library for the atomic-mode renderer.
 *
 * Each template is one residue's heavy-atom set in a CANONICAL local
 * frame defined as:
 *
 *   origin   = C1' position
 *   +z_local = strand 5'→3' tangent (= helix-axis direction)
 *   +y_local = direction OUTWARD from the helix axis (away from the
 *              centre).  +y_local is the convention used by the
 *              renderer's BaseAxisPoint.radial field.
 *   +x_local = z_local × y_local  (right-handed)
 *
 * The base atoms (N1, C2, ...) sit at NEGATIVE y_local — the base
 * extends INWARD from the sugar toward the helix axis where it
 * pairs with the partner strand.
 *
 * Templates baked from the user-supplied sample PDB
 * (`93347154ABD.pdb`) — see `tools/bake_residues.py` (this file's
 * sibling commentary block in the original commit message).  Atom
 * names follow the standard PDB convention.  Hydrogens are NOT
 * included; the atomic-mode default is heavy-atoms-only and the
 * scene density is busy enough already at sphere radius 0.30 Å.
 *
 * RNA residues (A, U, G, C) are derived from the matching DNA
 * template:
 *   • A/G/C: same heavy atoms as DA/DG/DC, plus O2' on the sugar
 *     (≈1.4 Å from C2', opposite the O4'→C2' direction).
 *   • U:     DT minus the C5-methyl (C7), plus O2'.
 *
 * For the bond-line style 3Dmol uses, exact A-form vs B-form sugar
 * pucker is invisible; we keep one geometry baseline for both.
 *
 * See `publications.md` R14 for the atom-naming convention and
 * per-residue counts.
 */

export interface ResidueAtomTemplate {
  name: string;
  elem: string;
  /** Local-frame x-coordinate (Å). */
  x: number;
  /** Local-frame y-coordinate (Å) — positive = outward from helix axis. */
  y: number;
  /** Local-frame z-coordinate (Å) — positive = strand 5'→3' direction. */
  z: number;
}

// ============================================================
// RESIDUE ATOM TEMPLATES (auto-baked — see tools/bake_residues.py)
// ============================================================
export const RESIDUE_TEMPLATES: Record<string, ResidueAtomTemplate[]> = {
  DA: [
    { name: "P", elem: "P", x: -4.79, y: -1.526, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.25, y: -0.569, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.516, y: -2.904, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.503, y: -0.94, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.358, y: 0.483, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.89, y: 0.86, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.338, y: 0.432, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N9", elem: "N", x: 0.09, y: -1.428, z: -0.42 },
    { name: "C8", elem: "C", x: -0.902, y: -2.364, z: -0.43 },
    { name: "N7", elem: "N", x: -0.52, y: -3.526, z: -0.85 },
    { name: "C5", elem: "C", x: 0.826, y: -3.344, z: -1.13 },
    { name: "C6", elem: "C", x: 1.822, y: -4.217, z: -1.61 },
    { name: "N6", elem: "N", x: 1.597, y: -5.504, z: -1.91 },
    { name: "N1", elem: "N", x: 3.057, y: -3.708, z: -1.78 },
    { name: "C2", elem: "C", x: 3.277, y: -2.435, z: -1.48 },
    { name: "N3", elem: "N", x: 2.443, y: -1.527, z: -1.02 },
    { name: "C4", elem: "C", x: 1.212, y: -2.063, z: -0.87 },
    { name: "C3'", elem: "C", x: -0.996, y: 0.186, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.366, y: 0.242, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.997, y: 0.867, z: 3.39 },
  ],
  DT: [
    { name: "P", elem: "P", x: -4.837, y: -1.369, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.264, y: -0.397, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.607, y: -2.755, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.531, y: -0.825, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.339, y: 0.591, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.86, y: 0.922, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.323, y: 0.474, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N1", elem: "N", x: 0.044, y: -1.43, z: -0.42 },
    { name: "C6", elem: "C", x: -1.088, y: -2.205, z: -0.37 },
    { name: "C5", elem: "C", x: -1.061, y: -3.49, z: -0.74 },
    { name: "C7", elem: "C", x: -2.266, y: -4.382, z: -0.71 },
    { name: "C4", elem: "C", x: 0.159, y: -4.107, z: -1.21 },
    { name: "O4", elem: "O", x: 0.278, y: -5.283, z: -1.57 },
    { name: "N3", elem: "N", x: 1.242, y: -3.255, z: -1.22 },
    { name: "C2", elem: "C", x: 1.248, y: -1.923, z: -0.84 },
    { name: "O2", elem: "O", x: 2.26, y: -1.25, z: -0.89 },
    { name: "C3'", elem: "C", x: -0.989, y: 0.219, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.374, y: 0.229, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.967, y: 0.9, z: 3.39 },
  ],
  DG: [
    { name: "P", elem: "P", x: -4.794, y: -1.511, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.251, y: -0.552, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.525, y: -2.89, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.505, y: -0.929, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.356, y: 0.492, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.887, y: 0.867, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.337, y: 0.435, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N9", elem: "N", x: 0.086, y: -1.427, z: -0.42 },
    { name: "C8", elem: "C", x: -0.904, y: -2.38, z: -0.44 },
    { name: "N7", elem: "N", x: -0.503, y: -3.559, z: -0.87 },
    { name: "C5", elem: "C", x: 0.852, y: -3.367, z: -1.14 },
    { name: "C6", elem: "C", x: 1.819, y: -4.276, z: -1.63 },
    { name: "O6", elem: "O", x: 1.691, y: -5.458, z: -1.93 },
    { name: "N1", elem: "N", x: 3.072, y: -3.663, z: -1.77 },
    { name: "C2", elem: "C", x: 3.353, y: -2.339, z: -1.47 },
    { name: "N2", elem: "N", x: 4.608, y: -1.938, z: -1.67 },
    { name: "N3", elem: "N", x: 2.438, y: -1.482, z: -1.01 },
    { name: "C4", elem: "C", x: 1.217, y: -2.068, z: -0.87 },
    { name: "C3'", elem: "C", x: -0.995, y: 0.189, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.367, y: 0.241, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.994, y: 0.871, z: 3.39 },
  ],
  DC: [
    { name: "P", elem: "P", x: -4.822, y: -1.423, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.26, y: -0.455, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.577, y: -2.806, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.521, y: -0.865, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.347, y: 0.554, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.87, y: 0.901, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.329, y: 0.46, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N1", elem: "N", x: 0.06, y: -1.429, z: -0.42 },
    { name: "C6", elem: "C", x: -1.054, y: -2.214, z: -0.38 },
    { name: "C5", elem: "C", x: -1.0, y: -3.515, z: -0.75 },
    { name: "C4", elem: "C", x: 0.269, y: -4.012, z: -1.2 },
    { name: "N4", elem: "N", x: 0.393, y: -5.277, z: -1.58 },
    { name: "N3", elem: "N", x: 1.364, y: -3.234, z: -1.24 },
    { name: "C2", elem: "C", x: 1.278, y: -1.93, z: -0.85 },
    { name: "O2", elem: "O", x: 2.259, y: -1.17, z: -0.87 },
    { name: "C3'", elem: "C", x: -0.992, y: 0.207, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.371, y: 0.234, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.977, y: 0.888, z: 3.39 },
  ],
  A: [
    { name: "P", elem: "P", x: -4.79, y: -1.526, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.25, y: -0.569, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.516, y: -2.904, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.503, y: -0.94, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.358, y: 0.483, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.89, y: 0.86, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.338, y: 0.432, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N9", elem: "N", x: 0.09, y: -1.428, z: -0.42 },
    { name: "C8", elem: "C", x: -0.902, y: -2.364, z: -0.43 },
    { name: "N7", elem: "N", x: -0.52, y: -3.526, z: -0.85 },
    { name: "C5", elem: "C", x: 0.826, y: -3.344, z: -1.13 },
    { name: "C6", elem: "C", x: 1.822, y: -4.217, z: -1.61 },
    { name: "N6", elem: "N", x: 1.597, y: -5.504, z: -1.91 },
    { name: "N1", elem: "N", x: 3.057, y: -3.708, z: -1.78 },
    { name: "C2", elem: "C", x: 3.277, y: -2.435, z: -1.48 },
    { name: "N3", elem: "N", x: 2.443, y: -1.527, z: -1.02 },
    { name: "C4", elem: "C", x: 1.212, y: -2.063, z: -0.87 },
    { name: "C3'", elem: "C", x: -0.996, y: 0.186, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.366, y: 0.242, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.997, y: 0.867, z: 3.39 },
    { name: "O2'", elem: "O", x: 1.379, y: 0.129, z: 2.435 },
  ],
  U: [
    { name: "P", elem: "P", x: -4.837, y: -1.369, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.264, y: -0.397, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.607, y: -2.755, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.531, y: -0.825, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.339, y: 0.591, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.86, y: 0.922, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.323, y: 0.474, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N1", elem: "N", x: 0.044, y: -1.43, z: -0.42 },
    { name: "C6", elem: "C", x: -1.088, y: -2.205, z: -0.37 },
    { name: "C5", elem: "C", x: -1.061, y: -3.49, z: -0.74 },
    { name: "C4", elem: "C", x: 0.159, y: -4.107, z: -1.21 },
    { name: "O4", elem: "O", x: 0.278, y: -5.283, z: -1.57 },
    { name: "N3", elem: "N", x: 1.242, y: -3.255, z: -1.22 },
    { name: "C2", elem: "C", x: 1.248, y: -1.923, z: -0.84 },
    { name: "O2", elem: "O", x: 2.26, y: -1.25, z: -0.89 },
    { name: "C3'", elem: "C", x: -0.989, y: 0.219, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.374, y: 0.229, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.967, y: 0.9, z: 3.39 },
    { name: "O2'", elem: "O", x: 1.382, y: 0.083, z: 2.435 },
  ],
  G: [
    { name: "P", elem: "P", x: -4.794, y: -1.511, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.251, y: -0.552, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.525, y: -2.89, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.505, y: -0.929, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.356, y: 0.492, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.887, y: 0.867, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.337, y: 0.435, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N9", elem: "N", x: 0.086, y: -1.427, z: -0.42 },
    { name: "C8", elem: "C", x: -0.904, y: -2.38, z: -0.44 },
    { name: "N7", elem: "N", x: -0.503, y: -3.559, z: -0.87 },
    { name: "C5", elem: "C", x: 0.852, y: -3.367, z: -1.14 },
    { name: "C6", elem: "C", x: 1.819, y: -4.276, z: -1.63 },
    { name: "O6", elem: "O", x: 1.691, y: -5.458, z: -1.93 },
    { name: "N1", elem: "N", x: 3.072, y: -3.663, z: -1.77 },
    { name: "C2", elem: "C", x: 3.353, y: -2.339, z: -1.47 },
    { name: "N2", elem: "N", x: 4.608, y: -1.938, z: -1.67 },
    { name: "N3", elem: "N", x: 2.438, y: -1.482, z: -1.01 },
    { name: "C4", elem: "C", x: 1.217, y: -2.068, z: -0.87 },
    { name: "C3'", elem: "C", x: -0.995, y: 0.189, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.367, y: 0.241, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.994, y: 0.871, z: 3.39 },
    { name: "O2'", elem: "O", x: 1.38, y: 0.126, z: 2.434 },
  ],
  C: [
    { name: "P", elem: "P", x: -4.822, y: -1.423, z: 2.02 },
    { name: "OP1", elem: "O", x: -5.26, y: -0.455, z: 3.06 },
    { name: "OP2", elem: "O", x: -4.577, y: -2.806, z: 2.49 },
    { name: "O5'", elem: "O", x: -3.521, y: -0.865, z: 1.29 },
    { name: "C5'", elem: "C", x: -3.347, y: 0.554, z: 1.15 },
    { name: "C4'", elem: "C", x: -1.87, y: 0.901, z: 1.09 },
    { name: "O4'", elem: "O", x: -1.329, y: 0.46, z: -0.18 },
    { name: "C1'", elem: "C", x: 0.0, y: 0.0, z: 0.0 },
    { name: "N1", elem: "N", x: 0.06, y: -1.429, z: -0.42 },
    { name: "C6", elem: "C", x: -1.054, y: -2.214, z: -0.38 },
    { name: "C5", elem: "C", x: -1.0, y: -3.515, z: -0.75 },
    { name: "C4", elem: "C", x: 0.269, y: -4.012, z: -1.2 },
    { name: "N4", elem: "N", x: 0.393, y: -5.277, z: -1.58 },
    { name: "N3", elem: "N", x: 1.364, y: -3.234, z: -1.24 },
    { name: "C2", elem: "C", x: 1.278, y: -1.93, z: -0.85 },
    { name: "O2", elem: "O", x: 2.259, y: -1.17, z: -0.87 },
    { name: "C3'", elem: "C", x: -0.992, y: 0.207, z: 2.13 },
    { name: "C2'", elem: "C", x: 0.371, y: 0.234, z: 1.46 },
    { name: "O3'", elem: "O", x: -0.977, y: 0.888, z: 3.39 },
    { name: "O2'", elem: "O", x: 1.381, y: 0.1, z: 2.435 },
  ],
};

// ============================================================
// INTRA-RESIDUE BOND TABLE
// ============================================================
//
// Bonds are listed by atom-name pair.  The atomic emitter resolves
// names to per-frame atom serials so 3Dmol can draw line/stick bonds.
// Inter-residue bonds (P of i+1 ↔ O3' of i) are added by the emitter
// once consecutive residues have known serials.
export const RESIDUE_BONDS: Record<string, [string, string][]> = {
  DA: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N9"], ["N9", "C8"], ["C8", "N7"], ["N7", "C5"],
    ["C5", "C6"], ["C6", "N6"], ["C6", "N1"], ["N1", "C2"],
    ["C2", "N3"], ["N3", "C4"], ["C4", "C5"], ["C4", "N9"],
  ],
  DG: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N9"], ["N9", "C8"], ["C8", "N7"], ["N7", "C5"],
    ["C5", "C6"], ["C6", "O6"], ["C6", "N1"], ["N1", "C2"],
    ["C2", "N2"], ["C2", "N3"], ["N3", "C4"], ["C4", "C5"], ["C4", "N9"],
  ],
  DT: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N1"], ["N1", "C2"], ["C2", "O2"], ["C2", "N3"],
    ["N3", "C4"], ["C4", "O4"], ["C4", "C5"], ["C5", "C7"],
    ["C5", "C6"], ["C6", "N1"],
  ],
  DC: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N1"], ["N1", "C2"], ["C2", "O2"], ["C2", "N3"],
    ["N3", "C4"], ["C4", "N4"], ["C4", "C5"], ["C5", "C6"], ["C6", "N1"],
  ],
  A: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N9"], ["N9", "C8"], ["C8", "N7"], ["N7", "C5"],
    ["C5", "C6"], ["C6", "N6"], ["C6", "N1"], ["N1", "C2"],
    ["C2", "N3"], ["N3", "C4"], ["C4", "C5"], ["C4", "N9"],
    ["C2'", "O2'"],
  ],
  U: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N1"], ["N1", "C2"], ["C2", "O2"], ["C2", "N3"],
    ["N3", "C4"], ["C4", "O4"], ["C4", "C5"], ["C5", "C6"], ["C6", "N1"],
    ["C2'", "O2'"],
  ],
  G: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N9"], ["N9", "C8"], ["C8", "N7"], ["N7", "C5"],
    ["C5", "C6"], ["C6", "O6"], ["C6", "N1"], ["N1", "C2"],
    ["C2", "N2"], ["C2", "N3"], ["N3", "C4"], ["C4", "C5"], ["C4", "N9"],
    ["C2'", "O2'"],
  ],
  C: [
    ["P", "OP1"], ["P", "OP2"], ["P", "O5'"],
    ["O5'", "C5'"], ["C5'", "C4'"], ["C4'", "O4'"], ["C4'", "C3'"],
    ["O4'", "C1'"], ["C1'", "C2'"], ["C2'", "C3'"], ["C3'", "O3'"],
    ["C1'", "N1"], ["N1", "C2"], ["C2", "O2"], ["C2", "N3"],
    ["N3", "C4"], ["C4", "N4"], ["C4", "C5"], ["C5", "C6"], ["C6", "N1"],
    ["C2'", "O2'"],
  ],
};

/* ------------------------------------------------------------------ */
/* Public API — emitResidueAtoms                                       */
/* ------------------------------------------------------------------ */

/** Coarse RNA-or-DNA tag used for residue-name normalisation. */
export type ResidueKind = "DNA" | "RNA";

/** Normalise a base char (A/T/G/C/U) + a kind to the template key. */
export function residueKey(base: string, kind: ResidueKind): string {
  const b = base.toUpperCase();
  if (kind === "DNA") {
    if (b === "A") return "DA";
    if (b === "T" || b === "U") return "DT";
    if (b === "G") return "DG";
    if (b === "C") return "DC";
    return "DA";
  }
  // RNA
  if (b === "A") return "A";
  if (b === "T" || b === "U") return "U";
  if (b === "G") return "G";
  if (b === "C") return "C";
  return "A";
}

/** Template lookup with fallback to DA so an unknown base never crashes. */
export function getResidueAtoms(
  base: string,
  kind: ResidueKind,
): ResidueAtomTemplate[] {
  return RESIDUE_TEMPLATES[residueKey(base, kind)] ?? RESIDUE_TEMPLATES.DA;
}

/** Bond table for the matching residue. */
export function getResidueBonds(
  base: string,
  kind: ResidueKind,
): [string, string][] {
  return RESIDUE_BONDS[residueKey(base, kind)] ?? RESIDUE_BONDS.DA;
}

/* ------------------------------------------------------------------ */
/* Per-base atom emission                                              */
/* ------------------------------------------------------------------ */

/**
 * Inputs for emitting one residue's atoms in scene coordinates.
 *
 * - `c1Pos`     : where the C1' should land (the existing schematic
 *                 sphere position is exactly this — no re-anchoring
 *                 needed).
 * - `tangent`   : unit vector along the strand 5'→3' direction.
 * - `outward`   : unit vector pointing from C1' AWAY from the helix
 *                 axis.  For coding strand outside the bubble this is
 *                 BaseAxisPoint.radial; for template strand it's the
 *                 NEGATIVE of radial (template wraps to the opposite
 *                 side of the axis).  Inside the bubble where the
 *                 strand bulges/dips, callers pass a derived per-base
 *                 outward direction (see `strandTangent` notes in
 *                 schematic.ts).
 * - `twist`     : helical-phase rotation around the axis (B-form:
 *                 i × 36°).  Rotates the entire residue around the
 *                 helix axis so consecutive residues stack correctly
 *                 into a helix.
 */
export interface EmitInput {
  c1Pos: [number, number, number];
  tangent: [number, number, number];
  outward: [number, number, number];
  twist: number;
}

/**
 * Build the local-frame basis vectors (e_x, e_y, e_z) in scene
 * coordinates from the inputs.  The template's local +y_local maps
 * to the (rotated) outward direction; +z_local maps to tangent;
 * +x_local = z × y completes the right-handed frame.  The twist
 * rotates the (x, y) plane around z — since templates were baked
 * with C1' at origin, this rotation is purely cosmetic for the
 * sugar/base orientation but it ensures consecutive residues' bases
 * stack with proper helical chirality.
 */
function buildBasis(
  tangent: [number, number, number],
  outward: [number, number, number],
  twist: number,
): {
  ex: [number, number, number];
  ey: [number, number, number];
  ez: [number, number, number];
} {
  // Apply twist: rotate `outward` and `e_x = z × outward` by `twist`
  // around the tangent axis.
  // Rodrigues for rotation of v around unit-vector k by angle θ:
  //   v' = v cos θ + (k×v) sin θ + k (k·v) (1 - cos θ)
  const c = Math.cos(twist);
  const s = Math.sin(twist);
  const k = tangent;
  const v = outward;
  const kdotv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const kxv: [number, number, number] = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  const ey: [number, number, number] = [
    v[0] * c + kxv[0] * s + k[0] * kdotv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdotv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdotv * (1 - c),
  ];
  // Re-orthonormalise (numerical drift over many residues).
  const eyMag = Math.hypot(ey[0], ey[1], ey[2]) || 1;
  ey[0] /= eyMag; ey[1] /= eyMag; ey[2] /= eyMag;
  const ez: [number, number, number] = [k[0], k[1], k[2]];
  // e_x = z × y
  const ex: [number, number, number] = [
    ez[1] * ey[2] - ez[2] * ey[1],
    ez[2] * ey[0] - ez[0] * ey[2],
    ez[0] * ey[1] - ez[1] * ey[0],
  ];
  return { ex, ey, ez };
}

/**
 * Output of `emitResidueAtoms`: scene positions for each atom, in the
 * same order as the residue's template.  The renderer maps these to
 * 3Dmol-compatible Atom records (chain, serial, bonds).
 */
export interface EmittedAtom {
  name: string;
  elem: string;
  pos: [number, number, number];
}

export function emitResidueAtoms(
  base: string,
  kind: ResidueKind,
  input: EmitInput,
): EmittedAtom[] {
  const template = getResidueAtoms(base, kind);
  const { ex, ey, ez } = buildBasis(input.tangent, input.outward, input.twist);
  const [cx, cy, cz] = input.c1Pos;
  const out: EmittedAtom[] = new Array(template.length);
  for (let i = 0; i < template.length; i++) {
    const a = template[i];
    out[i] = {
      name: a.name,
      elem: a.elem,
      pos: [
        cx + a.x * ex[0] + a.y * ey[0] + a.z * ez[0],
        cy + a.x * ex[1] + a.y * ey[1] + a.z * ez[1],
        cz + a.x * ex[2] + a.y * ey[2] + a.z * ez[2],
      ],
    };
  }
  return out;
}
