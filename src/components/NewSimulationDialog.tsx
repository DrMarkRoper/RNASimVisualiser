/**
 * NewSimulationDialog.tsx
 * -----------------------
 * Modal for authoring a blank run-configuration file, either from scratch
 * ("Create new") or pre-filled from the currently-loaded simulation ("Clone
 * current").
 *
 * The dialog validates every field, then on success writes a JSON blob that
 * the Python engine can consume as a run configuration.  The `snapshots`
 * array is left empty — the engine fills it when the simulation runs.
 * The `promoter` block is zeroed out for the same reason (promoter detection
 * also happens in Python).
 *
 * Download : standard Blob + <a download> approach — no server round-trip.
 * Send     : URL input is present; the POST logic is a future milestone.
 */

import { useEffect, useRef, useState } from "react";
import type { SimulationManifest } from "../types/manifest";

export type NewSimMode = "create" | "clone";

interface NewSimulationDialogProps {
  open: boolean;
  mode: NewSimMode;
  /** Currently-loaded manifest — used to pre-fill field values in clone mode. */
  manifest: SimulationManifest;
  onClose: () => void;
}

// Default values matching Python KineticParams defaults.
const DEFAULTS = {
  name: "",
  sequence: "",
  temperature_c: "37",
  ntp_A: "300",
  ntp_U: "300",
  ntp_G: "300",
  ntp_C: "300",
  greb_conc_uM: "0.1",
  rho_enabled: true,
  k_cat: "50",
  p_abortive_base: "0.6",
  abortive_decay: "0.18",
  hairpin_dg_threshold: "-3.0",
  escape_length: "11",
};

type FieldErrors = Record<string, string>;

// ------------------------------------------------------------------ helpers

function revComp(seq: string): string {
  const map: Record<string, string> = {
    A: "T", T: "A", G: "C", C: "G", N: "N",
  };
  return seq.toUpperCase().split("").reverse().map((b) => map[b] ?? "N").join("");
}

function flt(s: string): number { return parseFloat(s); }
function int(s: string): number { return parseInt(s, 10); }
function isFinite_(s: string): boolean { return Number.isFinite(parseFloat(s)); }

function validate(f: {
  name: string;
  sequence: string;
  temperature_c: string;
  ntp_A: string; ntp_U: string; ntp_G: string; ntp_C: string;
  greb_conc_uM: string;
  k_cat: string;
  p_abortive_base: string;
  abortive_decay: string;
  hairpin_dg_threshold: string;
  escape_length: string;
}): FieldErrors {
  const e: FieldErrors = {};

  if (!f.name.trim()) e.name = "Required.";

  const seq = f.sequence.trim().toUpperCase();
  if (!seq) {
    e.sequence = "Required.";
  } else if (!/^[ACGT]+$/.test(seq)) {
    e.sequence = "Only A, C, G, T are allowed.";
  } else if (seq.length < 80) {
    e.sequence = `${seq.length} bp — at least 80 bp recommended for reliable promoter detection.`;
  }

  if (!isFinite_(f.temperature_c) || flt(f.temperature_c) < 4 || flt(f.temperature_c) > 75)
    e.temperature_c = "Must be 4 – 75 °C.";

  for (const [key, val] of [
    ["ntp_A", f.ntp_A], ["ntp_U", f.ntp_U],
    ["ntp_G", f.ntp_G], ["ntp_C", f.ntp_C],
  ] as [string, string][]) {
    if (!isFinite_(val) || flt(val) < 1 || flt(val) > 5000)
      e[key] = "1 – 5000 µM.";
  }

  if (!isFinite_(f.greb_conc_uM) || flt(f.greb_conc_uM) < 0 || flt(f.greb_conc_uM) > 100)
    e.greb_conc_uM = "0 – 100 µM.";

  if (!isFinite_(f.k_cat) || flt(f.k_cat) <= 0 || flt(f.k_cat) > 1000)
    e.k_cat = "0.01 – 1000 s⁻¹.";

  if (!isFinite_(f.p_abortive_base) || flt(f.p_abortive_base) < 0 || flt(f.p_abortive_base) > 1)
    e.p_abortive_base = "0 – 1.";

  if (!isFinite_(f.abortive_decay) || flt(f.abortive_decay) < 0 || flt(f.abortive_decay) > 5)
    e.abortive_decay = "0 – 5.";

  if (!isFinite_(f.hairpin_dg_threshold) || flt(f.hairpin_dg_threshold) >= 0)
    e.hairpin_dg_threshold = "Must be negative (e.g. −3.0).";

  const escN = int(f.escape_length);
  if (!Number.isInteger(escN) || isNaN(escN) || escN < 6 || escN > 25)
    e.escape_length = "Integer 6 – 25.";

  return e;
}

function buildJson(
  name: string, sequence: string,
  temperature_c: string,
  ntp_A: string, ntp_U: string, ntp_G: string, ntp_C: string,
  greb_conc_uM: string, rho_enabled: boolean,
  k_cat: string, p_abortive_base: string, abortive_decay: string,
  hairpin_dg_threshold: string, escape_length: string,
): string {
  const seq = sequence.trim().toUpperCase();
  return JSON.stringify({
    application: "RNASim",
    version: "1.0",
    metadata: {
      sequence_name: name.trim(),
      created_at: new Date().toISOString(),
      random_seed: null,
      total_frames: 0,
      total_time_s: 0,
      final_rna_length: 0,
      final_phase: "",
    },
    sequence: {
      coding_strand: seq,
      template_strand: revComp(seq),
      tss_index: 0,
      sequence_length: seq.length,
    },
    // Promoter fields are intentionally zeroed — the Python engine detects
    // the promoter at run time; these placeholders allow the file to parse
    // through the Zod schema if loaded by the viewer (it will show score 0%).
    promoter: {
      tss: 1, pos_35: 0, pos_10: 0,
      hexamer_35: "------", hexamer_10: "------",
      spacer_len: 0, promoter_score: 0,
      w433_contacts: "NN", extended_minus10: false,
    },
    params: {
      temperature_c: flt(temperature_c),
      ntp_conc_uM: { A: flt(ntp_A), U: flt(ntp_U), G: flt(ntp_G), C: flt(ntp_C) },
      greb_conc_uM: flt(greb_conc_uM),
      rho_enabled,
      k_cat: flt(k_cat),
      p_abortive_base: flt(p_abortive_base),
      abortive_decay: flt(abortive_decay),
      hairpin_dg_threshold: flt(hairpin_dg_threshold),
      escape_length: int(escape_length),
    },
    snapshots: [],
  }, null, 2);
}

function triggerDownload(json: string, filename: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- component

export function NewSimulationDialog({
  open, mode, manifest, onClose,
}: NewSimulationDialogProps) {
  const p = manifest.params;

  // All numeric fields are kept as strings so a partially-typed value like
  // "1." is never coerced back to "1" by a React re-render.
  const [name,        setName]       = useState(DEFAULTS.name);
  const [sequence,    setSequence]   = useState(DEFAULTS.sequence);
  const [tempC,       setTempC]      = useState(DEFAULTS.temperature_c);
  const [ntpA,        setNtpA]       = useState(DEFAULTS.ntp_A);
  const [ntpU,        setNtpU]       = useState(DEFAULTS.ntp_U);
  const [ntpG,        setNtpG]       = useState(DEFAULTS.ntp_G);
  const [ntpC,        setNtpC]       = useState(DEFAULTS.ntp_C);
  const [greb,        setGreb]       = useState(DEFAULTS.greb_conc_uM);
  const [rhoEnabled,  setRhoEnabled] = useState(DEFAULTS.rho_enabled);
  const [kCat,        setKCat]       = useState(DEFAULTS.k_cat);
  const [pAbort,      setPAbort]     = useState(DEFAULTS.p_abortive_base);
  const [aDecay,      setADecay]     = useState(DEFAULTS.abortive_decay);
  const [hdg,         setHdg]        = useState(DEFAULTS.hairpin_dg_threshold);
  const [esc,         setEsc]        = useState(DEFAULTS.escape_length);

  const [errors,      setErrors]     = useState<FieldErrors>({});
  const [submitted,   setSubmitted]  = useState(false);
  const [serverUrl,   setServerUrl]  = useState("");
  const [serverNote,  setServerNote] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  // Seed the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSubmitted(false);
    setServerNote(null);

    if (mode === "clone") {
      setName(`${manifest.metadata.sequence_name} (copy)`);
      setSequence(manifest.sequence.coding_strand);
      setTempC(String(p.temperature_c));
      setNtpA(String(p.ntp_conc_uM["A"] ?? 300));
      setNtpU(String(p.ntp_conc_uM["U"] ?? 300));
      setNtpG(String(p.ntp_conc_uM["G"] ?? 300));
      setNtpC(String(p.ntp_conc_uM["C"] ?? 300));
      setGreb(String(p.greb_conc_uM));
      setRhoEnabled(p.rho_enabled);
      setKCat(String(p.k_cat ?? 50));
      setPAbort(String(p.p_abortive_base ?? 0.6));
      setADecay(String(p.abortive_decay ?? 0.18));
      setHdg(String(p.hairpin_dg_threshold ?? -3.0));
      setEsc(String(p.escape_length ?? 11));
    } else {
      setName(DEFAULTS.name);
      setSequence(DEFAULTS.sequence);
      setTempC(DEFAULTS.temperature_c);
      setNtpA(DEFAULTS.ntp_A);
      setNtpU(DEFAULTS.ntp_U);
      setNtpG(DEFAULTS.ntp_G);
      setNtpC(DEFAULTS.ntp_C);
      setGreb(DEFAULTS.greb_conc_uM);
      setRhoEnabled(DEFAULTS.rho_enabled);
      setKCat(DEFAULTS.k_cat);
      setPAbort(DEFAULTS.p_abortive_base);
      setADecay(DEFAULTS.abortive_decay);
      setHdg(DEFAULTS.hairpin_dg_threshold);
      setEsc(DEFAULTS.escape_length);
    }
    setTimeout(() => nameRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // ---------------------------------------------------------------- actions

  const currentFields = {
    name, sequence,
    temperature_c: tempC,
    ntp_A: ntpA, ntp_U: ntpU, ntp_G: ntpG, ntp_C: ntpC,
    greb_conc_uM: greb,
    k_cat: kCat, p_abortive_base: pAbort,
    abortive_decay: aDecay, hairpin_dg_threshold: hdg,
    escape_length: esc,
  };

  const handleDownload = () => {
    setSubmitted(true);
    const errs = validate(currentFields);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const json = buildJson(
      name, sequence, tempC,
      ntpA, ntpU, ntpG, ntpC, greb, rhoEnabled,
      kCat, pAbort, aDecay, hdg, esc,
    );
    const slug = name.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "") || "simulation";
    triggerDownload(json, `${slug}_config.json`);
  };

  const handleSend = () => {
    setServerNote("Send to server is not yet implemented.");
  };

  // ---------------------------------------------------------------- render helpers

  const errFor = (field: string) =>
    submitted && errors[field]
      ? <span className="nsf-error" role="alert">{errors[field]}</span>
      : null;

  const rowCls = (field: string) =>
    "nsf-row" + (submitted && errors[field] ? " nsf-row--error" : "");

  const errorCount = Object.keys(errors).length;

  // ---------------------------------------------------------------- JSX

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => onClose()}
    >
      <div
        className="modal-dialog new-sim-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-sim-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="new-sim-title">
            {mode === "clone" ? "Clone Simulation" : "Create New Simulation"}
          </h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className="modal-body new-sim-body">
          <form
            onSubmit={(e) => { e.preventDefault(); handleDownload(); }}
            noValidate
          >
            {/* ── Simulation ───────────────────────────────────────── */}
            <div className="nsf-section">
              <h4 className="nsf-section-title">Simulation</h4>

              <div className={rowCls("name")}>
                <label htmlFor="nsf-name">Name</label>
                <div className="nsf-input-wrap">
                  <input
                    ref={nameRef}
                    id="nsf-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my_simulation"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {errFor("name")}
                </div>
              </div>

              <div className={rowCls("sequence")}>
                <label htmlFor="nsf-seq">DNA sequence</label>
                <div className="nsf-input-wrap">
                  <textarea
                    id="nsf-seq"
                    className="nsf-seq-textarea"
                    value={sequence}
                    onChange={(e) => setSequence(e.target.value)}
                    placeholder={"ACGT…  coding strand, 5′→3′\n(minimum 80 bp recommended)"}
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                  />
                  {errFor("sequence")}
                  {!errors.sequence && sequence.trim().length > 0 && (
                    <span className="nsf-hint">
                      {sequence.trim().toUpperCase().replace(/[^ACGT]/g, "").length} valid bp
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ── Conditions (Tier 1) ──────────────────────────────── */}
            <div className="nsf-section">
              <h4 className="nsf-section-title">Conditions</h4>

              <div className={rowCls("temperature_c")}>
                <label htmlFor="nsf-temp">Temperature</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input
                      id="nsf-temp"
                      type="number"
                      value={tempC}
                      step="0.5"
                      onChange={(e) => setTempC(e.target.value)}
                    />
                    <span className="nsf-unit">°C</span>
                  </div>
                  {errFor("temperature_c")}
                </div>
              </div>

              {/* NTP concentrations — 2×2 compact grid */}
              <div className="nsf-row">
                <label>NTP (µM)</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-ntp-grid">
                    {(
                      [
                        ["A", ntpA, setNtpA],
                        ["U", ntpU, setNtpU],
                        ["G", ntpG, setNtpG],
                        ["C", ntpC, setNtpC],
                      ] as [string, string, (v: string) => void][]
                    ).map(([base, val, setter]) => {
                      const eKey = `ntp_${base}`;
                      return (
                        <div
                          key={base}
                          className={"nsf-ntp-cell" + (submitted && errors[eKey] ? " nsf-ntp-cell--error" : "")}
                        >
                          <label htmlFor={`nsf-ntp-${base}`}>{base}</label>
                          <input
                            id={`nsf-ntp-${base}`}
                            type="number"
                            value={val}
                            step="10"
                            min="1"
                            onChange={(e) => setter(e.target.value)}
                          />
                        </div>
                      );
                    })}
                  </div>
                  {/* Show one error message if any NTP is invalid */}
                  {submitted && ["ntp_A", "ntp_U", "ntp_G", "ntp_C"].some((k) => errors[k]) && (
                    <span className="nsf-error">NTP concentrations must be 1–5000 µM.</span>
                  )}
                </div>
              </div>

              <div className={rowCls("greb_conc_uM")}>
                <label htmlFor="nsf-greb">GreB</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input
                      id="nsf-greb"
                      type="number"
                      value={greb}
                      step="0.01"
                      min="0"
                      onChange={(e) => setGreb(e.target.value)}
                    />
                    <span className="nsf-unit">µM</span>
                  </div>
                  {errFor("greb_conc_uM")}
                  <span className="nsf-hint">Set to 0 to disable GreB transcript cleavage.</span>
                </div>
              </div>

              <div className="nsf-row">
                <label htmlFor="nsf-rho">Rho factor</label>
                <div className="nsf-input-wrap nsf-checkbox-wrap">
                  <label className="nsf-checkbox-label">
                    <input
                      id="nsf-rho"
                      type="checkbox"
                      checked={rhoEnabled}
                      onChange={(e) => setRhoEnabled(e.target.checked)}
                    />
                    {rhoEnabled ? "enabled" : "disabled"}
                  </label>
                </div>
              </div>
            </div>

            {/* ── Kinetics (Tier 2) ────────────────────────────────── */}
            <div className="nsf-section">
              <h4 className="nsf-section-title">Kinetics</h4>

              <div className={rowCls("k_cat")}>
                <label htmlFor="nsf-kcat">Elongation rate</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input
                      id="nsf-kcat"
                      type="number"
                      value={kCat}
                      step="1"
                      min="0.1"
                      onChange={(e) => setKCat(e.target.value)}
                    />
                    <span className="nsf-unit">s⁻¹</span>
                  </div>
                  {errFor("k_cat")}
                  <span className="nsf-hint">k<sub>cat</sub> — max NTP addition rate at saturating [NTP].</span>
                </div>
              </div>

              <div className={rowCls("p_abortive_base")}>
                <label htmlFor="nsf-pabort">Abortive prob. (n=2)</label>
                <div className="nsf-input-wrap">
                  <input
                    id="nsf-pabort"
                    type="number"
                    value={pAbort}
                    step="0.05"
                    min="0"
                    max="1"
                    onChange={(e) => setPAbort(e.target.value)}
                  />
                  {errFor("p_abortive_base")}
                  <span className="nsf-hint">Release probability at transcript length 2.</span>
                </div>
              </div>

              <div className={rowCls("abortive_decay")}>
                <label htmlFor="nsf-adecay">Abortive decay</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input
                      id="nsf-adecay"
                      type="number"
                      value={aDecay}
                      step="0.01"
                      min="0"
                      onChange={(e) => setADecay(e.target.value)}
                    />
                    <span className="nsf-unit">per nt</span>
                  </div>
                  {errFor("abortive_decay")}
                  <span className="nsf-hint">Exponential decay of abortive probability with transcript length.</span>
                </div>
              </div>

              <div className={rowCls("escape_length")}>
                <label htmlFor="nsf-esc">Escape length</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input
                      id="nsf-esc"
                      type="number"
                      value={esc}
                      step="1"
                      min="6"
                      max="25"
                      onChange={(e) => setEsc(e.target.value)}
                    />
                    <span className="nsf-unit">nt</span>
                  </div>
                  {errFor("escape_length")}
                  <span className="nsf-hint">Transcript length at which RNAP commits to elongation.</span>
                </div>
              </div>

              <div className={rowCls("hairpin_dg_threshold")}>
                <label htmlFor="nsf-hdg">Hairpin ΔG threshold</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input
                      id="nsf-hdg"
                      type="number"
                      value={hdg}
                      step="0.5"
                      onChange={(e) => setHdg(e.target.value)}
                    />
                    <span className="nsf-unit">kcal/mol</span>
                  </div>
                  {errFor("hairpin_dg_threshold")}
                  <span className="nsf-hint">Hairpins more stable than this trigger intrinsic termination.</span>
                </div>
              </div>
            </div>

            {/* ── Output ───────────────────────────────────────────── */}
            <div className="nsf-section nsf-output-section">
              <h4 className="nsf-section-title">Output</h4>

              {submitted && errorCount > 0 && (
                <div className="nsf-form-error" role="alert">
                  {errorCount} field{errorCount > 1 ? "s" : ""} need
                  {errorCount === 1 ? "s" : ""} attention — see above.
                </div>
              )}

              <div className="nsf-output-row">
                {/* Download */}
                <div className="nsf-output-block">
                  <p className="nsf-output-label">Download configuration file</p>
                  <button
                    type="submit"
                    className="nsf-action-btn nsf-action-btn--primary"
                  >
                    Download JSON
                  </button>
                </div>

                <div className="nsf-output-divider">or</div>

                {/* Send to server */}
                <div className="nsf-output-block">
                  <p className="nsf-output-label">Send to simulation server</p>
                  <div className="nsf-server-row">
                    <input
                      type="text"
                      className="nsf-server-url"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://your-server.example.com/run"
                      disabled
                      aria-label="Server URL"
                    />
                    <button
                      type="button"
                      className="nsf-action-btn"
                      onClick={handleSend}
                      title="Coming soon"
                      disabled
                    >
                      Send
                    </button>
                  </div>
                  {serverNote
                    ? <span className="nsf-hint nsf-hint--note">{serverNote}</span>
                    : <span className="nsf-hint">Server integration coming soon.</span>
                  }
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
