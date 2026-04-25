/**
 * NewSimulationDialog.tsx
 * -----------------------
 * Modal for authoring a run-configuration file, either from scratch
 * ("Create new") or pre-filled from the currently-loaded simulation
 * ("Clone current").
 *
 * The dialog validates every field, then offers two output paths:
 *
 *   Download JSON
 *     Builds the config blob and triggers a browser download.  The file
 *     can be run later with `python -m rnasim --fasta ...` or submitted
 *     to the simulation server.
 *
 *   Send to server
 *     POSTs the config to a running RNASim server (server/server.py).
 *     Progress is streamed back via Server-Sent Events and shown inline.
 *     When the simulation completes the "Load into viewer" button appears.
 */

import { useEffect, useRef, useState } from "react";
import { parseManifest, type SimulationManifest } from "../types/manifest";

export type NewSimMode = "create" | "clone";

interface NewSimulationDialogProps {
  open: boolean;
  mode: NewSimMode;
  /** Currently-loaded manifest — used to pre-fill field values in clone mode. */
  manifest: SimulationManifest;
  onClose: () => void;
  /** Called when the user loads a completed server-run into the viewer. */
  onLoaded?: (manifest: SimulationManifest) => void;
}

// Default values matching Python KineticParams defaults.
const DEFAULTS = {
  name:                  "",
  sequence:              "",
  temperature_c:         "37",
  ntp_A:                 "300",
  ntp_U:                 "300",
  ntp_G:                 "300",
  ntp_C:                 "300",
  greb_conc_uM:          "0.1",
  rho_enabled:           true,
  k_cat:                 "50",
  p_abortive_base:       "0.6",
  abortive_decay:        "0.18",
  hairpin_dg_threshold:  "-3.0",
  escape_length:         "11",
};

type FieldErrors = Record<string, string>;
type SendState   = "idle" | "sending" | "done" | "error";

// ------------------------------------------------------------------ helpers

function revComp(seq: string): string {
  const map: Record<string, string> = { A:"T", T:"A", G:"C", C:"G", N:"N" };
  return seq.toUpperCase().split("").reverse().map(b => map[b] ?? "N").join("");
}

const flt = (s: string) => parseFloat(s);
const int = (s: string) => parseInt(s, 10);
const fin = (s: string) => Number.isFinite(parseFloat(s));

function validate(f: {
  name: string; sequence: string;
  temperature_c: string;
  ntp_A: string; ntp_U: string; ntp_G: string; ntp_C: string;
  greb_conc_uM: string;
  k_cat: string; p_abortive_base: string; abortive_decay: string;
  hairpin_dg_threshold: string; escape_length: string;
}): FieldErrors {
  const e: FieldErrors = {};

  if (!f.name.trim()) e.name = "Required.";

  const seq = f.sequence.trim().toUpperCase();
  if (!seq) {
    e.sequence = "Required.";
  } else if (!/^[ACGT]+$/.test(seq)) {
    e.sequence = "Only A, C, G, T are allowed.";
  } else if (seq.length < 80) {
    e.sequence = `${seq.length} bp — at least 80 bp recommended for promoter detection.`;
  }

  if (!fin(f.temperature_c) || flt(f.temperature_c) < 4 || flt(f.temperature_c) > 75)
    e.temperature_c = "Must be 4 – 75 °C.";

  for (const [k, v] of [
    ["ntp_A", f.ntp_A], ["ntp_U", f.ntp_U],
    ["ntp_G", f.ntp_G], ["ntp_C", f.ntp_C],
  ] as [string, string][]) {
    if (!fin(v) || flt(v) < 1 || flt(v) > 5000) e[k] = "1 – 5000 µM.";
  }

  if (!fin(f.greb_conc_uM) || flt(f.greb_conc_uM) < 0 || flt(f.greb_conc_uM) > 100)
    e.greb_conc_uM = "0 – 100 µM.";

  if (!fin(f.k_cat) || flt(f.k_cat) <= 0 || flt(f.k_cat) > 1000)
    e.k_cat = "0.01 – 1000 s⁻¹.";

  if (!fin(f.p_abortive_base) || flt(f.p_abortive_base) < 0 || flt(f.p_abortive_base) > 1)
    e.p_abortive_base = "0 – 1.";

  if (!fin(f.abortive_decay) || flt(f.abortive_decay) < 0 || flt(f.abortive_decay) > 5)
    e.abortive_decay = "0 – 5.";

  if (!fin(f.hairpin_dg_threshold) || flt(f.hairpin_dg_threshold) >= 0)
    e.hairpin_dg_threshold = "Must be negative (e.g. −3.0).";

  const escN = int(f.escape_length);
  if (isNaN(escN) || escN < 6 || escN > 25) e.escape_length = "Integer 6 – 25.";

  return e;
}

function buildConfigJson(
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
      sequence_name:  name.trim(),
      created_at:     new Date().toISOString(),
      random_seed:    null,
      total_frames:   0,
      total_time_s:   0,
      final_rna_length: 0,
      final_phase:    "",
    },
    sequence: {
      coding_strand:    seq,
      template_strand:  revComp(seq),
      tss_index:        0,          // server computes this from len // 2
      sequence_length:  seq.length,
    },
    // Promoter fields are zeroed — the Python engine detects the promoter
    // at run time.  The placeholder values keep the Zod schema happy if
    // the file is opened in the viewer before running.
    promoter: {
      tss: 1, pos_35: 0, pos_10: 0,
      hexamer_35: "------", hexamer_10: "------",
      spacer_len: 0, promoter_score: 0,
      w433_contacts: "NN", extended_minus10: false,
    },
    params: {
      temperature_c:         flt(temperature_c),
      ntp_conc_uM:           { A: flt(ntp_A), U: flt(ntp_U), G: flt(ntp_G), C: flt(ntp_C) },
      greb_conc_uM:          flt(greb_conc_uM),
      rho_enabled,
      k_cat:                 flt(k_cat),
      p_abortive_base:       flt(p_abortive_base),
      abortive_decay:        flt(abortive_decay),
      hairpin_dg_threshold:  flt(hairpin_dg_threshold),
      escape_length:         int(escape_length),
    },
    snapshots: [],
  }, null, 2);
}

function triggerDownload(json: string, filename: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- component

export function NewSimulationDialog({
  open, mode, manifest, onClose, onLoaded,
}: NewSimulationDialogProps) {
  const p = manifest.params;

  // ── Form state (all numeric fields kept as strings) ──────────────
  const [name,       setName]       = useState(DEFAULTS.name);
  const [sequence,   setSequence]   = useState(DEFAULTS.sequence);
  const [tempC,      setTempC]      = useState(DEFAULTS.temperature_c);
  const [ntpA,       setNtpA]       = useState(DEFAULTS.ntp_A);
  const [ntpU,       setNtpU]       = useState(DEFAULTS.ntp_U);
  const [ntpG,       setNtpG]       = useState(DEFAULTS.ntp_G);
  const [ntpC,       setNtpC]       = useState(DEFAULTS.ntp_C);
  const [greb,       setGreb]       = useState(DEFAULTS.greb_conc_uM);
  const [rhoEnabled, setRhoEnabled] = useState(DEFAULTS.rho_enabled);
  const [kCat,       setKCat]       = useState(DEFAULTS.k_cat);
  const [pAbort,     setPAbort]     = useState(DEFAULTS.p_abortive_base);
  const [aDecay,     setADecay]     = useState(DEFAULTS.abortive_decay);
  const [hdg,        setHdg]        = useState(DEFAULTS.hairpin_dg_threshold);
  const [esc,        setEsc]        = useState(DEFAULTS.escape_length);

  // ── Form validation state ────────────────────────────────────────
  const [errors,    setErrors]    = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  // ── Server / send state ──────────────────────────────────────────
  const [serverUrl,     setServerUrl]     = useState("http://localhost:8000");
  const [sendState,     setSendState]     = useState<SendState>("idle");
  const [sendStatus,    setSendStatus]    = useState("");
  const [sendProgress,  setSendProgress]  = useState<{ frame: number; total: number; phase: string } | null>(null);
  const [sendResult,    setSendResult]    = useState<{ url: string; frames: number; phase: string } | null>(null);
  const [sendError,     setSendError]     = useState<string | null>(null);
  const [loadingResult, setLoadingResult] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const esRef   = useRef<EventSource | null>(null);

  // ── Seed / reset on open ─────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    setErrors({}); setSubmitted(false);
    setSendState("idle"); setSendProgress(null);
    setSendStatus(""); setSendResult(null);
    setSendError(null); setLoadingResult(false);

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
      setName(DEFAULTS.name); setSequence(DEFAULTS.sequence);
      setTempC(DEFAULTS.temperature_c);
      setNtpA(DEFAULTS.ntp_A); setNtpU(DEFAULTS.ntp_U);
      setNtpG(DEFAULTS.ntp_G); setNtpC(DEFAULTS.ntp_C);
      setGreb(DEFAULTS.greb_conc_uM); setRhoEnabled(DEFAULTS.rho_enabled);
      setKCat(DEFAULTS.k_cat); setPAbort(DEFAULTS.p_abortive_base);
      setADecay(DEFAULTS.abortive_decay); setHdg(DEFAULTS.hairpin_dg_threshold);
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

  // ── Shared validation helper ─────────────────────────────────────
  const currentFields = {
    name, sequence,
    temperature_c: tempC,
    ntp_A: ntpA, ntp_U: ntpU, ntp_G: ntpG, ntp_C: ntpC,
    greb_conc_uM: greb,
    k_cat: kCat, p_abortive_base: pAbort,
    abortive_decay: aDecay, hairpin_dg_threshold: hdg,
    escape_length: esc,
  };

  const doValidate = () => {
    const errs = validate(currentFields);
    setErrors(errs);
    return errs;
  };

  // ── Download ─────────────────────────────────────────────────────
  const handleDownload = () => {
    setSubmitted(true);
    if (Object.keys(doValidate()).length > 0) return;
    const json = buildConfigJson(
      name, sequence, tempC, ntpA, ntpU, ntpG, ntpC,
      greb, rhoEnabled, kCat, pAbort, aDecay, hdg, esc,
    );
    const slug = name.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "") || "simulation";
    triggerDownload(json, `${slug}_config.json`);
  };

  // ── Send to server ───────────────────────────────────────────────
  const handleSend = async () => {
    setSubmitted(true);
    if (Object.keys(doValidate()).length > 0) return;

    const base = serverUrl.trim().replace(/\/$/, "");
    if (!base) { setSendError("Enter a server URL."); return; }
    try { new URL(base); } catch { setSendError("Invalid URL — use e.g. http://localhost:8000."); return; }

    setSendState("sending");
    setSendProgress(null);
    setSendStatus("Connecting…");
    setSendError(null);
    setSendResult(null);

    const configJson = buildConfigJson(
      name, sequence, tempC, ntpA, ntpU, ntpG, ntpC,
      greb, rhoEnabled, kCat, pAbort, aDecay, hdg, esc,
    );

    // POST to start the job
    let jobId: string;
    try {
      const resp = await fetch(`${base}/api/run`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    configJson,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `Server returned HTTP ${resp.status}`);
      }
      const data = await resp.json() as { job_id: string };
      jobId = data.job_id;
    } catch (e) {
      setSendState("error");
      setSendError(e instanceof Error ? e.message : "Failed to reach server.");
      return;
    }

    // Subscribe to SSE stream
    const es = new EventSource(`${base}/api/run/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (ev) => {
      type SseEvent = {
        type: string;
        message?: string;
        frame?: number; total?: number; phase?: string;
        url?: string; frames?: number;
      };
      const data = JSON.parse(ev.data) as SseEvent;

      switch (data.type) {
        case "status":
          setSendStatus(data.message ?? "");
          break;
        case "progress":
          setSendProgress({ frame: data.frame ?? 0, total: data.total ?? 0, phase: data.phase ?? "" });
          setSendStatus("Simulating…");
          break;
        case "done":
          setSendResult({ url: `${base}${data.url!}`, frames: data.frames ?? 0, phase: data.phase ?? "" });
          setSendState("done");
          es.close();
          break;
        case "error":
          setSendError(data.message ?? "Unknown server error.");
          setSendState("error");
          es.close();
          break;
        case "timeout":
          setSendError("Simulation timed out on the server.");
          setSendState("error");
          es.close();
          break;
      }
    };

    es.onerror = () => {
      // Only surface the error if we're still in the sending state
      // (avoid spurious errors fired after intentional close).
      setSendState(prev => {
        if (prev === "sending") setSendError("Connection to server lost.");
        return prev === "sending" ? "error" : prev;
      });
      es.close();
    };
  };

  // ── Load completed result into viewer ───────────────────────────
  const handleLoadResult = async () => {
    if (!sendResult || !onLoaded) return;
    setLoadingResult(true);
    try {
      const resp = await fetch(sendResult.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching simulation file.`);
      const raw  = await resp.json();
      const mfst = parseManifest(raw);
      onLoaded(mfst);
      onClose();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to load simulation.");
      setLoadingResult(false);
    }
  };

  // ── Render helpers ───────────────────────────────────────────────
  const errFor = (field: string) =>
    submitted && errors[field]
      ? <span className="nsf-error" role="alert">{errors[field]}</span>
      : null;

  const rowCls = (field: string) =>
    "nsf-row" + (submitted && errors[field] ? " nsf-row--error" : "");

  const errorCount = Object.keys(errors).length;
  const isSending  = sendState === "sending";

  // ── JSX ──────────────────────────────────────────────────────────
  return (
    <div className="modal-backdrop" onMouseDown={() => onClose()}>
      <div
        className="modal-dialog new-sim-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-sim-title"
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="new-sim-title">
            {mode === "clone" ? "Clone Simulation" : "Create New Simulation"}
          </h3>
          <button type="button" className="modal-close" onClick={onClose}
                  aria-label="Close" title="Close">×</button>
        </header>

        <div className="modal-body new-sim-body">
          <form onSubmit={e => { e.preventDefault(); handleDownload(); }} noValidate>

            {/* ── Simulation ───────────────────────────────────── */}
            <div className="nsf-section">
              <h4 className="nsf-section-title">Simulation</h4>

              <div className={rowCls("name")}>
                <label htmlFor="nsf-name">Name</label>
                <div className="nsf-input-wrap">
                  <input ref={nameRef} id="nsf-name" type="text" value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="my_simulation" autoComplete="off" spellCheck={false} />
                  {errFor("name")}
                </div>
              </div>

              <div className={rowCls("sequence")}>
                <label htmlFor="nsf-seq">DNA sequence</label>
                <div className="nsf-input-wrap">
                  <textarea id="nsf-seq" className="nsf-seq-textarea" value={sequence}
                    onChange={e => setSequence(e.target.value)}
                    placeholder={"ACGT…  coding strand, 5′→3′\n(minimum 80 bp recommended)"}
                    rows={4} spellCheck={false} autoComplete="off" autoCorrect="off" />
                  {errFor("sequence")}
                  {!errors.sequence && sequence.trim().length > 0 && (
                    <span className="nsf-hint">
                      {sequence.trim().toUpperCase().replace(/[^ACGT]/g, "").length} valid bp
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ── Conditions (Tier 1) ──────────────────────────── */}
            <div className="nsf-section">
              <h4 className="nsf-section-title">Conditions</h4>

              <div className={rowCls("temperature_c")}>
                <label htmlFor="nsf-temp">Temperature</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input id="nsf-temp" type="number" value={tempC} step="0.5"
                           onChange={e => setTempC(e.target.value)} />
                    <span className="nsf-unit">°C</span>
                  </div>
                  {errFor("temperature_c")}
                </div>
              </div>

              <div className="nsf-row">
                <label>NTP (µM)</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-ntp-grid">
                    {([["A", ntpA, setNtpA], ["U", ntpU, setNtpU],
                       ["G", ntpG, setNtpG], ["C", ntpC, setNtpC],
                    ] as [string, string, (v: string) => void][]).map(([base, val, setter]) => {
                      const eKey = `ntp_${base}`;
                      return (
                        <div key={base}
                             className={"nsf-ntp-cell" + (submitted && errors[eKey] ? " nsf-ntp-cell--error" : "")}>
                          <label htmlFor={`nsf-ntp-${base}`}>{base}</label>
                          <input id={`nsf-ntp-${base}`} type="number" value={val}
                                 step="10" min="1" onChange={e => setter(e.target.value)} />
                        </div>
                      );
                    })}
                  </div>
                  {submitted && ["ntp_A","ntp_U","ntp_G","ntp_C"].some(k => errors[k]) && (
                    <span className="nsf-error">NTP concentrations must be 1 – 5000 µM.</span>
                  )}
                </div>
              </div>

              <div className={rowCls("greb_conc_uM")}>
                <label htmlFor="nsf-greb">GreB</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input id="nsf-greb" type="number" value={greb} step="0.01" min="0"
                           onChange={e => setGreb(e.target.value)} />
                    <span className="nsf-unit">µM</span>
                  </div>
                  {errFor("greb_conc_uM")}
                  <span className="nsf-hint">Set to 0 to disable GreB cleavage.</span>
                </div>
              </div>

              <div className="nsf-row">
                <label htmlFor="nsf-rho">Rho factor</label>
                <div className="nsf-input-wrap nsf-checkbox-wrap">
                  <label className="nsf-checkbox-label">
                    <input id="nsf-rho" type="checkbox" checked={rhoEnabled}
                           onChange={e => setRhoEnabled(e.target.checked)} />
                    {rhoEnabled ? "enabled" : "disabled"}
                  </label>
                </div>
              </div>
            </div>

            {/* ── Kinetics (Tier 2) ────────────────────────────── */}
            <div className="nsf-section">
              <h4 className="nsf-section-title">Kinetics</h4>

              <div className={rowCls("k_cat")}>
                <label htmlFor="nsf-kcat">Elongation rate</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input id="nsf-kcat" type="number" value={kCat} step="1" min="0.1"
                           onChange={e => setKCat(e.target.value)} />
                    <span className="nsf-unit">s⁻¹</span>
                  </div>
                  {errFor("k_cat")}
                  <span className="nsf-hint">k<sub>cat</sub> — max NTP addition rate at saturating [NTP].</span>
                </div>
              </div>

              <div className={rowCls("p_abortive_base")}>
                <label htmlFor="nsf-pabort">Abortive prob. (n=2)</label>
                <div className="nsf-input-wrap">
                  <input id="nsf-pabort" type="number" value={pAbort} step="0.05" min="0" max="1"
                         onChange={e => setPAbort(e.target.value)} />
                  {errFor("p_abortive_base")}
                  <span className="nsf-hint">Release probability at transcript length 2.</span>
                </div>
              </div>

              <div className={rowCls("abortive_decay")}>
                <label htmlFor="nsf-adecay">Abortive decay</label>
                <div className="nsf-input-wrap">
                  <div className="nsf-unit-row">
                    <input id="nsf-adecay" type="number" value={aDecay} step="0.01" min="0"
                           onChange={e => setADecay(e.target.value)} />
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
                    <input id="nsf-esc" type="number" value={esc} step="1" min="6" max="25"
                           onChange={e => setEsc(e.target.value)} />
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
                    <input id="nsf-hdg" type="number" value={hdg} step="0.5"
                           onChange={e => setHdg(e.target.value)} />
                    <span className="nsf-unit">kcal/mol</span>
                  </div>
                  {errFor("hairpin_dg_threshold")}
                  <span className="nsf-hint">Hairpins more stable than this trigger intrinsic termination.</span>
                </div>
              </div>
            </div>

            {/* ── Output ───────────────────────────────────────── */}
            <div className="nsf-section nsf-output-section">
              <h4 className="nsf-section-title">Output</h4>

              {submitted && errorCount > 0 && (
                <div className="nsf-form-error" role="alert">
                  {errorCount} field{errorCount > 1 ? "s" : ""} need
                  {errorCount === 1 ? "s" : ""} attention — see above.
                </div>
              )}

              <div className="nsf-output-row">

                {/* ── Download ──────────────────────────────────── */}
                <div className="nsf-output-block">
                  <p className="nsf-output-label">Download configuration file</p>
                  <button type="submit" className="nsf-action-btn nsf-action-btn--primary">
                    Download JSON
                  </button>
                  <span className="nsf-hint">Run later with<br /><code>python -m rnasim</code></span>
                </div>

                <div className="nsf-output-divider">or</div>

                {/* ── Send to server ────────────────────────────── */}
                <div className="nsf-output-block">
                  <p className="nsf-output-label">Send to simulation server</p>

                  <div className="nsf-server-row">
                    <input
                      type="text"
                      className="nsf-server-url"
                      value={serverUrl}
                      onChange={e => setServerUrl(e.target.value)}
                      placeholder="http://localhost:8000"
                      disabled={isSending}
                      aria-label="Server base URL"
                    />
                    <button
                      type="button"
                      className={"nsf-action-btn" + (isSending ? "" : " nsf-action-btn--send")}
                      onClick={() => void handleSend()}
                      disabled={isSending}
                    >
                      {isSending ? "Running…" : "Send"}
                    </button>
                  </div>

                  {/* Sending — progress */}
                  {sendState === "sending" && (
                    <div className="nsf-send-status">
                      <span className="nsf-spinner" aria-hidden="true" />
                      <span>{sendStatus}</span>
                      {sendProgress && (
                        <div className="nsf-progress-wrap">
                          <div className="nsf-progress-bar">
                            <div
                              className="nsf-progress-fill"
                              style={{ width: `${Math.min(100, (sendProgress.frame / Math.max(1, sendProgress.total)) * 100)}%` }}
                            />
                          </div>
                          <span className="nsf-progress-label">
                            Frame {sendProgress.frame} · {sendProgress.phase}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Done */}
                  {sendState === "done" && sendResult && (
                    <div className="nsf-send-done">
                      <span className="nsf-done-check">✓</span>
                      <span className="nsf-done-text">
                        {sendResult.frames} frames · {sendResult.phase}
                      </span>
                      {onLoaded && (
                        <button
                          type="button"
                          className="nsf-action-btn nsf-action-btn--primary nsf-load-btn"
                          onClick={() => void handleLoadResult()}
                          disabled={loadingResult}
                        >
                          {loadingResult ? "Loading…" : "Load into viewer"}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Error */}
                  {sendState === "error" && sendError && (
                    <div className="nsf-send-error-block">
                      <span className="nsf-error">{sendError}</span>
                      <button
                        type="button"
                        className="nsf-retry-btn"
                        onClick={() => { setSendState("idle"); setSendError(null); }}
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {sendState === "idle" && (
                    <span className="nsf-hint">
                      Start the server with:<br />
                      <code>python server/server.py</code>
                    </span>
                  )}
                </div>
              </div>
            </div>

          </form>
        </div>
      </div>
    </div>
  );
}
