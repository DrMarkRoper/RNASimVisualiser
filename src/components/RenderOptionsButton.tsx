import { useEffect, useRef, useState } from "react";

/**
 * Per-component render options for the 3D viewer.
 *
 * For now the only thing wired up in Viewer3D is the derived "overall"
 * mode (schematic / atomic — see `computeRenderLabel` below): the popup
 * lets the user pick a mode per scene component, but the individual
 * picks don't yet affect what is drawn. They are scaffolding for the
 * forthcoming per-component renderers.
 */
export type NucleicMode = "schematic" | "atomic";
export type ProteinMode = "schematic" | "mesh" | "atomic";

/**
 * How an *atomic-mode* nucleic-acid strand is drawn on screen.
 * Only meaningful when at least one of `options.{coding,template,rna}`
 * is set to `"atomic"`; if all three are `"schematic"`, the strand
 * picks themselves determine the rendering and this field is ignored
 * (the in-viewer pill is hidden in that case).
 *
 *  - `molecular` : per-residue heavy-atom detail — small spheres at
 *                  every heavy atom + chunky stick bonds (backbone,
 *                  sugar ring, base ring, glycosidic).  No backbone
 *                  ribbon.
 *  - `cartoon`   : phosphate-backbone ribbon only (smooth chunky bar
 *                  traced through the P atoms).  No per-atom
 *                  spheres / sticks.
 *  - `both`      : molecular drawn over the cartoon ribbon.
 *
 * Toggled by the legend bar's representation pill (next to Labels).
 */
export type Representation = "molecular" | "cartoon" | "both";

export interface RenderOptions {
  coding:   NucleicMode;
  template: NucleicMode;
  rna:      NucleicMode;
  /** σ⁷⁰ and W433 share a mode — W433 is a σ⁷⁰ region-2.3 residue. */
  sigma:    ProteinMode;
  rnap:     ProteinMode;
  /** Atomic-mode strand representation.  Has no visual effect when
   *  every strand pick is `"schematic"` (the per-strand spheres
   *  render unconditionally in that case).  Default `cartoon` is the
   *  least visually busy choice when the user first enables atomic
   *  mode for a strand. */
  representation: Representation;
}

export type RenderLabel = "schematic" | "atomic" | "mixed";

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  coding:   "schematic",
  template: "schematic",
  rna:      "schematic",
  sigma:    "schematic",
  rnap:     "schematic",
  representation: "cartoon",
};

const PROTEIN_MODES: ProteinMode[] = ["schematic", "mesh", "atomic"];

/**
 * Collapse a RenderOptions object to a single label for the button.
 * All components the same → that mode. Otherwise → "mixed".
 */
export function computeRenderLabel(opts: RenderOptions): RenderLabel {
  const values: string[] = [
    opts.coding,
    opts.template,
    opts.rna,
    opts.sigma,
    opts.rnap,
  ];
  if (values.every((v) => v === "schematic")) return "schematic";
  if (values.every((v) => v === "atomic"))    return "atomic";
  return "mixed";
}

interface Props {
  options: RenderOptions;
  onChange: (next: RenderOptions) => void;
}

export function RenderOptionsButton({ options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const label = computeRenderLabel(options);

  // Click-outside / Escape close the popup.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const update = (patch: Partial<RenderOptions>) => {
    onChange({ ...options, ...patch });
  };

  const setAllNucleic = (v: NucleicMode) => {
    onChange({
      ...options,
      coding: v, template: v, rna: v,
      sigma: v, rnap: v,
    });
  };

  return (
    <div className="render-options" ref={rootRef}>
      <span className="render-options-caption">render</span>
      <button
        type="button"
        className={"render-options-btn" + (open ? " open" : "")}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Per-component render modes"
      >
        <span className="render-options-btn-label">{label}</span>
        <span className="render-options-btn-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="render-options-popup" role="dialog" aria-label="Render options">
          <header className="render-options-popup-header">
            <strong>Render mode</strong>
            <div className="render-options-quick">
              <button type="button" onClick={() => setAllNucleic("schematic")}>
                all schematic
              </button>
              <button type="button" onClick={() => setAllNucleic("atomic")}>
                all atomic
              </button>
            </div>
          </header>

          <div className="render-options-grid">
            <NucleicRow
              label="Template"
              value={options.template}
              onChange={(v) => update({ template: v })}
            />
            <NucleicRow
              label="Coding"
              value={options.coding}
              onChange={(v) => update({ coding: v })}
            />
            <NucleicRow
              label="RNA"
              value={options.rna}
              onChange={(v) => update({ rna: v })}
            />
            <ProteinRow
              label="σ⁷⁰ / W433"
              value={options.sigma}
              onChange={(v) => update({ sigma: v })}
            />
            <ProteinRow
              label="RNAP"
              value={options.rnap}
              onChange={(v) => update({ rnap: v })}
            />
          </div>

          <footer className="render-options-footer">
            σ⁷⁰ and RNAP support schematic / mesh independently.  Per-component
            atomic only takes effect when *all* components are atomic — the
            6ALF cartoon then supplies them.  Nucleic acid per-component picks
            are stubs pending the bent-DNA geometry rewrite.
          </footer>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                        */
/* ------------------------------------------------------------------ */

interface NucleicRowProps {
  label: string;
  value: NucleicMode;
  onChange: (v: NucleicMode) => void;
}

function NucleicRow({ label, value, onChange }: NucleicRowProps) {
  const name = `ro-${label}`;
  // Nucleic rows have no "mesh" option, but we still render an empty slot
  // in its position so the schematic/atomic pills line up vertically with
  // the corresponding pills on the 3-option protein rows below.
  return (
    <>
      <div className="ro-row-label">{label}</div>
      <div className="ro-row-opts">
        <label className={"ro-opt" + (value === "schematic" ? " active" : "")}>
          <input
            type="radio"
            name={name}
            checked={value === "schematic"}
            onChange={() => onChange("schematic")}
          />
          schematic
        </label>
        <span
          className="ro-opt ro-opt-spacer"
          aria-hidden="true"
          title="Mesh rendering is not meaningful for nucleic acids"
        >
          N/A
        </span>
        <label className={"ro-opt" + (value === "atomic" ? " active" : "")}>
          <input
            type="radio"
            name={name}
            checked={value === "atomic"}
            onChange={() => onChange("atomic")}
          />
          atomic
        </label>
      </div>
    </>
  );
}

interface ProteinRowProps {
  label: string;
  value: ProteinMode;
  onChange: (v: ProteinMode) => void;
}

function ProteinRow({ label, value, onChange }: ProteinRowProps) {
  const name = `ro-${label}`;
  return (
    <>
      <div className="ro-row-label">{label}</div>
      <div className="ro-row-opts">
        {PROTEIN_MODES.map((m) => (
          <label key={m} className={"ro-opt" + (value === m ? " active" : "")}>
            <input
              type="radio"
              name={name}
              checked={value === m}
              onChange={() => onChange(m)}
            />
            {m}
          </label>
        ))}
      </div>
    </>
  );
}
