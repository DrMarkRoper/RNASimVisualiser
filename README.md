# DNA to RNA Transcription Visualiser v.0.2

A browser-based, frame-by-frame visualiser for mechanistic bacterial transcription simulations. Watch σ⁷⁰ find and open a promoter, RNA polymerase scrunch and escape, elongate, pause, backtrack, and terminate — all animated in 3D and annotated on a live sequence panel.

Built with React + TypeScript + Vite, rendered with [3Dmol.js](https://3dmol.csb.pitt.edu/). No backend required: drop in a `snapshots.json` manifest and the app replays every frame in the browser.

https://github.com/user-attachments/assets/REPLACE-WITH-YOUR-VIDEO-URL

---

## Contents

- [What it simulates](#what-it-simulates)
- [Quick start](#quick-start)
- [Using the visualiser](#using-the-visualiser)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Timeline panel](#timeline-panel)
  - [Sequence panel](#sequence-panel)
  - [3D viewer](#3d-viewer)
  - [Loading simulations](#loading-simulations)
- [Timeline states reference](#timeline-states-reference)
- [Architecture](#architecture)
- [References](#references)

---

## What it simulates

Transcription is the process by which a DNA template is read and converted into messenger RNA (mRNA). In bacteria this is performed by a single multi-subunit enzyme — RNA polymerase (RNAP, core: α₂ββ′ω) — together with a dissociable initiation factor called σ⁷⁰ (sigma-70). The σ⁷⁰ subunit confers promoter specificity; once bound to RNAP it forms the holoenzyme (α₂ββ′ωσ) that can locate and open a promoter.

The visualiser replays a simulation manifest covering four stages of transcription:

### 1 · Initiation — finding and opening the promoter

The holoenzyme diffuses along DNA until σ⁷⁰ region 4 contacts the −35 hexamer and region 2 contacts the −10 hexamer, forming the closed complex (RPc). The enzyme then isomerises to the open complex (RPo): ≈ 13 bp of DNA are melted, and tryptophan residue W433 in σ⁷⁰ region 2.3 intercalates between bases −11 and −12 to stabilise the single-stranded bubble. Once open, RNAP begins synthesising short abortive transcripts (2–9 nt) while _scrunching_ downstream DNA into the body, storing elastic strain that will drive promoter escape.

### 2 · Promoter escape and σ⁷⁰ release

When the nascent RNA exceeds ≈ 9–11 nt the accumulated scrunching strain overcomes σ contacts, RNAP breaks free of the promoter, and σ⁷⁰ dissociates — leaving the core elongation complex to translocate processively downstream.

### 3 · Elongation — processive RNA synthesis

RNAP maintains a 13 bp transcription bubble and an 8–9 bp RNA:DNA hybrid. At each register the incoming NTP is selected by base-pairing with the template strand and incorporated by the catalytic Mg²⁺. The rate is sequence-dependent, governed by RNA:DNA hybrid stability. RNAP can pause at certain sequence motifs and may _backtrack_ — sliding upstream by 1 or more nucleotides, extruding the 3′ RNA end into a secondary channel. The transcript-cleavage factor GreB rescues arrested complexes by stimulating hydrolysis of the 3′ RNA.

### 4 · Termination — releasing RNA and DNA

Two pathways are modelled. **Intrinsic termination** is driven by a GC-rich RNA hairpin followed by a poly-U tract in the nascent transcript; the hairpin folds in the RNA exit channel and the weak rU:dA hybrid melts, releasing RNA and RNAP without any additional factors. **Rho-dependent termination** involves the Rho helicase tracking the nascent RNA and displacing RNAP at a pause site.

---

## Quick start

**Prerequisites:** Node 18+ (Node 22 recommended).

```bash
# Install dependencies and start the dev server
npm install
npm run dev
```

The dev server starts at <http://localhost:5173>.

Place your `snapshots.json` manifest in the `public/` folder before starting (or use the **Load** button in the app to open one at runtime — see [Loading simulations](#loading-simulations)).

### npm scripts

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Vite dev server with HMR                     |
| `npm run typecheck` | `tsc -b --noEmit` — type errors only         |
| `npm run build`     | Production build to `dist/`                  |
| `npm run preview`   | Serve the production build locally           |

---

## Using the visualiser

### Keyboard shortcuts

| Key | Action |
| --- | ------ |
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Shift` + `←` / `→` | Step ten frames |
| `Home` / `End` | Jump to first / last frame |

### Timeline panel

Two coloured lanes span the full simulation:

- **σ⁷⁰ lane (top)** — tracks σ⁷⁰ state from approaching through W433 intercalation to release.
- **RNAP lane (bottom)** — tracks the RNAP phase (initiation → open complex → scrunching → elongation → termination) with milestone event markers (promoter escape, GreB rescue, abortive release, arrest, termination).

The scrubber below the lanes lets you drag to any frame. When playback reaches the last frame the play button changes to **↺** — clicking it restarts from frame 0. The speed slider (1–60 fps) is at the top right.

### Sequence panel

Displays the coding (+) and/or template (−) strand with per-base annotations. Toggle strands using the controls above the panel, and use _Follow RNAP_ to keep the active site centred automatically. Coloured chips in the legend explain each highlight. Hairpin and U-tract annotations appear once RNAP has transcribed past the 3′ stem.

### 3D viewer

Click and drag to orbit; scroll to zoom. Use _'Reset view'_ in the legend bar to return to the initial orientation. Click any legend chip to hide or show that component.

The **render** button (top-right of the canvas) controls how each component is drawn:

| Mode | Description |
| ---- | ----------- |
| **Schematic** | Procedural cartoon — fast, always available. σ⁷⁰ shows only the two functional contacts: region 4 (−35 hexamer) and region 2 (−10 hexamer / W433 site). |
| **Regions** | Detailed rigid-body mesh for σ⁷⁰ subunits and RNAP, with on-canvas labels available via the _Labels_ toggle. |
| **Atomic** | Per-residue heavy-atom detail for the three nucleic-acid strands (coding, template, nascent RNA). Use the _Molecular / Cartoon / Both_ pill to switch representations. Not available for σ⁷⁰ or RNAP. |

### Loading simulations

Use the **Load** icon in the Sim Data tab to swap in a different simulation manifest — either by pasting a URL or dragging a local `.json` file. Use **New ▾** to clone the current simulation parameters and configure a new run.

---

## Timeline states reference

### σ⁷⁰ lane

| State | Description |
| ----- | ----------- |
| **Approaching** | σ⁷⁰ and core RNAP assemble in solution and descend to the promoter as a pre-formed holoenzyme. |
| **Bound** | Holoenzyme is docked on the promoter in the closed complex. σ region 4 contacts −35; region 2 contacts −10. W433 has not yet inserted. |
| **W433 inserting** | Trp-433 in σ region 2.3 is actively intercalating between bases −11 and −12, driving DNA melting and bubble opening. |
| **W433 intercalated** | W433 is fully wedged in. The transcription bubble is open (RPo); the complex is now competent for initial RNA synthesis. |
| **Releasing** | Promoter escape is in progress. σ⁷⁰ contacts are breaking as the elongating RNA exceeds the length that σ1.1 can accommodate. |
| **Released** | σ⁷⁰ has fully dissociated. RNAP is now a processive core enzyme; σ⁷⁰ is free to re-associate with another core for a new round of initiation. |

### RNAP lane

| State | Description |
| ----- | ----------- |
| **Approaching** | Holoenzyme assembly and promoter search. No RNA synthesis. |
| **Initiation** | Closed complex on the promoter. DNA melting (RPc → RPo isomerisation) not yet complete. |
| **Open complex** | Transcription bubble fully open (≈ 13 bp). First NTPs are incorporated; short abortive transcripts produced. |
| **Scrunching** | RNAP is held at the TSS by σ contacts while pulling downstream DNA into the body. Bubble grows; abortive release most likely here. |
| **Elongation** | Processive NTP incorporation after promoter escape. RNAP translocates one base per incorporation cycle. |
| **Paused** | RNAP has entered an elemental pause — translocation stalled at a sequence-specific register. Can resume spontaneously or backtrack. |
| **Backtracked** | RNAP slid upstream; the 3′ RNA end is extruded into the secondary channel. GreB (if present) can stimulate cleavage to rescue the complex. |
| **Terminated** | RNAP has stalled at the intrinsic termination site. The RNA hairpin is forming in the exit channel, destabilising the hybrid. |
| **Detaching** | Post-termination: RNA:DNA hybrid has melted, bubble is re-annealing, RNAP lifts off DNA. Completed transcript is released. |

---

## Architecture

```
src/
├── main.tsx                  — React bootstrap
├── App.tsx                   — layout shell, render-mode state
├── index.css                 — dark/light theme, grid layout
├── types/
│   ├── manifest.ts           — zod-validated SimulationManifest types
│   └── 3dmol.d.ts            — minimal shim for the 3Dmol module
├── hooks/
│   └── useManifest.ts        — fetch + validate /snapshots.json
├── utils/
│   └── phase.ts              — phase → colour / label mapping
├── components/
│   ├── Viewer3D.tsx          — 3Dmol.js mount + per-frame geometry push
│   ├── Timeline.tsx          — phase bands, event markers, scrubber, play/pause
│   ├── SequencePanel.tsx     — annotated coding strand + nascent RNA view
│   ├── InfoPanel.tsx         — Sim Data / Help / About tabbed panel
│   └── RenderOptionsButton.tsx — render-mode popup (schematic / regions / atomic)
└── render/
    ├── types.ts              — GeometryBuilder / Atom / GeometryFrame contract
    ├── schematic.ts          — procedural builder (B-form helix, bubble,
    │                            RNAP body, W433 indole ring, RNA thread)
    └── atomic.ts             — PDB-keyframe builder (falls back to
                                 schematic until atomic milestones land)
```

### Manifest → geometry pipeline

```
/snapshots.json
      │  useManifest
      ▼
SimulationManifest (zod-validated)
      │  App: (manifest, snapshot, renderOptions)
      ▼
Viewer3D ──▶ GeometryBuilder.build(manifest, snapshot, options)
                     │
                     ▼
            GeometryFrame { atoms[], hints }
                     │
                     ▼
            3Dmol model.addAtoms + setStyle + render
```

### Chain IDs

| Chain | Contents |
| ----- | -------- |
| `A` | Coding strand (non-template, +) |
| `B` | Template strand (−) |
| `R` | Nascent RNA emerging from the exit channel |
| `X` | Backtracked RNA in the secondary channel |
| `P` | RNAP body |
| `W` | σ⁷⁰ W433 indole ring |

### Coordinate system

All TSS-relative coordinates use the bacterial convention: `+1 = TSS`, no position `0`, negative upstream. The helper `coordToIndex(coord, tssIndex)` translates to a 0-based index into the full `coding_strand` / `template_strand` string.

---

## References

1. Santangelo, T. J. & Artsimovitch, I. Termination and antitermination: RNA polymerase runs a stop sign. _Nat Rev Microbiol_ 9, 319–329 (2011). doi:[10.1038/nrmicro2560](https://doi.org/10.1038/nrmicro2560)
2. Larson, M. H., Greenleaf, W. J., Landick, R. & Block, S. M. Applied force reveals mechanistic and energetic details of transcription termination. _Cell_ 132, 971–982 (2008). doi:[10.1016/j.cell.2008.01.027](https://doi.org/10.1016/j.cell.2008.01.027)
3. Nudler, E., Mustaev, A., Lukhtanov, E. & Goldfarb, A. The RNA-DNA hybrid maintains the register of transcription by preventing backtracking of RNA polymerase. _Cell_ 89, 33–41 (1997). doi:[10.1016/S0092-8674(00)80180-4](https://doi.org/10.1016/S0092-8674(00)80180-4)
4. Murakami, K. S. The X-ray crystal structure of _Escherichia coli_ RNA polymerase σ⁷⁰ holoenzyme. _J Biol Chem_ 288, 9126–9134 (2013). doi:[10.1096/fasebj.27.1_supplement.547.2](https://doi.org/10.1096/fasebj.27.1_supplement.547.2)
5. Revyakin, A., Liu, C., Ebright, R. H. & Strick, T. R. Abortive initiation and productive initiation by RNA polymerase involve DNA scrunching. _Science_ 314, 1139–1143 (2006). doi:[10.1126/science.1131398](https://doi.org/10.1126/science.1131398)
6. Kapanidis, A. N. _et al._ Initial transcription by RNA polymerase proceeds through a DNA-scrunching mechanism. _Science_ 314, 1144–1147 (2006). doi:[10.1126/science.1131399](https://doi.org/10.1126/science.1131399)
7. Murakami, K. S. Structural biology of bacterial RNA polymerase. _Biomolecules_ 5, 848–864 (2015). doi:[10.3390/biom5020848](https://doi.org/10.3390/biom5020848)
8. Yarnell, W. S. & Roberts, J. W. Mechanism of intrinsic transcription termination and antitermination. _Science_ 284, 611–615 (1999). doi:[10.1126/science.284.5414.611](https://doi.org/10.1126/science.284.5414.611)
9. You, L. _et al._ Structural basis for intrinsic transcription termination. _Nature_ 613, 783–789 (2023). doi:[10.1038/s41586-022-05604-1](https://doi.org/10.1038/s41586-022-05604-1)
10. Kang, J. Y. _et al._ Structural basis of transcription elongation by _Escherichia coli_ RNA polymerase. _eLife_ 6:e25478 (2017). doi:[10.7554/eLife.25478](https://doi.org/10.7554/eLife.25478)
11. Erie, D. A., Hajiseyedjavadi, O., Young, M. C. & von Hippel, P. H. Multiple RNA polymerase conformations and GreA: control of the fidelity of transcription. _Science_ 262, 867–873 (1993). doi:[10.1126/science.8235608](https://doi.org/10.1126/science.8235608)
12. Bai, L., Shundrovsky, A. & Wang, M. D. Sequence-dependent kinetic model for transcription elongation by RNA polymerase. _J Mol Biol_ 344, 335–349 (2004). doi:[10.1016/j.jmb.2004.08.107](https://doi.org/10.1016/j.jmb.2004.08.107)
13. Sugimoto, N. _et al._ Thermodynamic parameters to predict stability of RNA/DNA hybrid duplexes. _Biochemistry_ 34, 11211–11216 (1995). doi:[10.1021/bi00035a029](https://doi.org/10.1021/bi00035a029)
14. Turner, D. H. & Mathews, D. H. NNDB: the nearest neighbor parameter database for predicting stability of nucleic acid secondary structure. _Nucleic Acids Res_ 38, D280–D282 (2010). doi:[10.1093/nar/gkp892](https://doi.org/10.1093/nar/gkp892)
15. Vassylyev, D. G. _et al._ Structural basis for transcription elongation by bacterial RNA polymerase. _Nature_ 448, 157–162 (2007). doi:[10.1038/nature05932](https://doi.org/10.1038/nature05932)
16. Rego, N. & Koes, D. 3Dmol.js: molecular visualization with WebGL. _Bioinformatics_ 31, 1322–1324 (2015). doi:[10.1093/bioinformatics/btu829](https://doi.org/10.1093/bioinformatics/btu829)
