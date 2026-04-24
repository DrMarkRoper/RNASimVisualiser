# rnasim — frontend

React + TypeScript + Vite single-page app that plays back a simulation
manifest produced by the Python engine in `../rnasim/`.  Rendering uses
3Dmol.js with a **hybrid renderer** (schematic procedural mode today, atomic
PDB-keyframed mode stubbed behind the same interface).

No backend — the app loads `/snapshots.json` directly and replays every
frame in the browser.

## Running locally

Prerequisite: Node 18+ (Node 22 recommended).

```bash
# from repo root, first generate a manifest
source .venv/bin/activate
python -m rnasim --seq <your-sequence> --tss <n> --out snapshots.json --seed 42

cd frontend
./setup-frontend.sh                     # one-shot: symlink, npm install, npm run dev
# or manually:
#   ln -sf ../../snapshots.json public/snapshots.json
#   npm install
#   npm run dev
```

The dev server listens on <http://localhost:5173>.  Any regeneration of
`../snapshots.json` is picked up on the next page reload (the symlink means
no copy is needed).

### Scripts

| Command             | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Vite dev server with HMR                          |
| `npm run typecheck` | `tsc -b --noEmit` — catches type errors only      |
| `npm run build`     | Production build to `dist/`                       |
| `npm run preview`   | Serve the built site locally                      |

## Architecture

```
src/
├── main.tsx                  — React bootstrap
├── App.tsx                   — layout shell, render-mode toggle
├── index.css                 — dark theme, grid layout
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
│   └── InfoPanel.tsx         — promoter, conditions, live state readouts
└── render/
    ├── types.ts              — GeometryBuilder / Atom / GeometryFrame contract
    ├── schematic.ts          — procedural builder (B-form helix, bubble,
    │                            RNAP body, W433 indole, RNA thread, backtrack)
    └── atomic.ts             — stub PDB-keyframe builder (falls back to
                                 schematic until milestones 3–6 land)
```

### Manifest → geometry pipeline

```
/snapshots.json
      │   useManifest
      ▼
SimulationManifest (zod-validated)
      │   App: (manifest, snapshot, mode)
      ▼
Viewer3D ──▶ GeometryBuilder.build(manifest, snapshot)
                     │
                     ▼
            GeometryFrame { atoms[], hints }
                     │
                     ▼
            3Dmol model.addAtoms + setStyle + render
```

The `GeometryBuilder` interface is the pivot point.  The schematic and atomic
renderers are interchangeable — adding a new mode is a single implementation.

### What the schematic renderer draws today

*   Double helix for the whole template (coding = blue, template = red).
*   Transcription bubble expansion: bases within
    `[bubble_upstream, bubble_downstream]` are split onto two single strands
    with a visual lift along *y*.
*   RNAP body: two large translucent spheres approximating the crab-claw.
    These are placeholders for the procedural mesh (milestone 5).
*   W433 indole ring (10 atoms, chain `W`, residue 433) — lerped between
    retracted and fully intercalated using `snapshot.w433_depth`.
*   Nascent RNA thread (chain `R`) emerging from the exit channel.
*   Backtracked RNA thread (chain `X`) when `snapshot.backtrack_steps > 0`.

### What the atomic renderer will do (TODO)

Load PDB 6ALF (open complex), 6C6U (scrunched ITC), 6RIN (elongation) once on
start-up.  Per snapshot, choose the nearest keyframe by phase and interpolate
rigid-body transforms for clamp motion, scrunching translation, and template
bend.  Per-residue relabelling via the manifest sequence so the helix shows
the actual bases, not the generic PDB sequence.

## Component and data conventions

### Coordinate system

Every TSS-relative coordinate in the manifest uses the bacterial
convention: `+1 = TSS`, no position `0`, negative upstream.  The helper
`coordToIndex(coord, tssIndex)` translates that to a 0-based index into the
full `coding_strand`/`template_strand` string.

### Chain ids

| Chain | Contents                                      |
| ----- | --------------------------------------------- |
| `A`   | coding strand (non-template, +)               |
| `B`   | template strand (−)                           |
| `R`   | nascent RNA emerging from the exit channel    |
| `X`   | backtracked RNA in the secondary channel      |
| `P`   | RNAP body                                     |
| `W`   | σ⁷⁰ W433 indole ring                          |

Chain styling lives in `Viewer3D.tsx` — change colour/opacity/representation
there, not in the geometry builders.

### Event markers on the timeline

Only these milestone events are marked (pause events would be too dense):

* promoter escape
* termination (intrinsic / Rho)
* GreB cleavage rescue
* abortive release
* arrest

The phase bands carry per-frame phase colour already.

## Schema alignment with the Python engine

`src/types/manifest.ts` mirrors `rnasim/snapshot.py::SimulationManifest` key
for key.  If `to_dict()` changes, the zod schema here must be updated or
validation will reject the file with a clear error.

Validated in this scaffold against a real run with:
*   450 snapshots
*   151 bp sequence
*   phases observed: initiation, open_complex, elongation, paused,
    backtracked, terminated
*   event types observed: elemental pause, GreB cleaved, abortive release,
    promoter escape, intrinsic termination

## Notes for the next session

*   **Geometry milestones still to land** (see handoff): template 90° bend
    inside the active-site cleft, coding-strand loop over the clamp and
    re-annealing downstream, and the full procedural crab-claw mesh.
*   **Web Worker move** — once the geometry builders get expensive, move
    `builder.build()` off the main thread.  The `GeometryFrame` contract is
    already cleanly serialisable (plain atom records, no functions).
*   **Export** — PNG per-frame is a few lines against 3Dmol's `.pngURI()`.
    MP4 recording via `MediaRecorder` on the WebGL canvas.
*   **Atomic builder** — drop real PDB parsing into `render/atomic.ts`.  The
    `GeometryFrame` return shape stays the same, so no change to Viewer3D.
