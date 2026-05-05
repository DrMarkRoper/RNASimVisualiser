import { useCallback, useEffect, useRef, useState } from "react";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { NewSimMode } from "./NewSimulationDialog";

interface InfoPanelProps {
  manifest: SimulationManifest;
  snapshot: Snapshot;
  /** Where this manifest came from — filename, URL, or server URL. */
  source?: string;
  /** Opens the Load Simulation File modal.  Owned by App so the modal
   *  itself lives above the grid instead of inside the info panel. */
  onLoadSimulation?: () => void;
  /** Opens the New Simulation modal in create or clone mode. */
  onNewSimulation?: (mode: NewSimMode) => void;
}

type InfoTab = "sim" | "help" | "info";

const TABS: Array<{ id: InfoTab; label: string }> = [
  { id: "sim",  label: "Sim Data" },
  { id: "help", label: "Help" },
  { id: "info", label: "About" },
];

/**
 * Right-rail tabbed panel.
 *
 *   • Sim Data — run info, promoter parameters, kinetic conditions, and the
 *                live per-frame state readout. This is the "live" tab; the
 *                other two are static reference material.
 *   • Info     — stub for future reference material (publication links,
 *                mechanism diagrams, glossary).
 *   • Help     — user-facing instructions & keyboard shortcuts.
 */
export function InfoPanel({ manifest, snapshot, source, onLoadSimulation, onNewSimulation }: InfoPanelProps) {
  const [tab, setTab] = useState<InfoTab>("sim");

  return (
    <aside className="info-panel">
      <nav className="info-tabs" role="tablist" aria-label="Info panel sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`info-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={"info-tab" + (tab === t.id ? " active" : "")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* All three tab bodies are rendered concurrently and their visibility
          is toggled via the `hidden` attribute (display: none).  This gives
          each tab its own scroll container, so scrolling halfway down Sim
          Data and switching to Help no longer leaves Help scrolled by the
          previous offset — each panel keeps its own scrollTop, and an
          inactive tab's DOM is preserved (cheap; the trees are small). */}
      <div
        className="info-tab-body"
        role="tabpanel"
        aria-labelledby="info-tab-sim"
        hidden={tab !== "sim"}
      >
        <SimDataTab
          manifest={manifest}
          snapshot={snapshot}
          source={source}
          onLoadSimulation={onLoadSimulation}
          onNewSimulation={onNewSimulation}
        />
      </div>
      <div
        className="info-tab-body"
        role="tabpanel"
        aria-labelledby="info-tab-info"
        hidden={tab !== "info"}
      >
        <InfoTab />
      </div>
      <div
        className="info-tab-body"
        role="tabpanel"
        aria-labelledby="info-tab-help"
        hidden={tab !== "help"}
      >
        <HelpTab />
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Sim Data                                                           */
/* ------------------------------------------------------------------ */

/**
 * Single-line, ellipsis-clipped, selectable display of a long sequence with
 * an inline copy-to-clipboard control.  Used for the coding-strand readout
 * in the Sim Data tab — a typical demo sequence is 200+ nt and would blow
 * out the info panel layout if rendered with normal wrap, so we clip with
 * `text-overflow: ellipsis` and rely on the copy button (or native text
 * selection) for full retrieval.
 */
function CopyableSequence({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      // navigator.clipboard is available on HTTPS / localhost contexts.
      // Fallback path uses a transient textarea + execCommand for older
      // browsers / file:// embeds.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Don't tear down the UI — surface a console warning and leave the
      // user free to drag-select the visible portion.
      console.warn("Copy failed:", err);
    }
  }, [value]);

  return (
    <div className="copyable-sequence">
      <code
        className="copyable-sequence-text"
        title={value}
        aria-label={`${label} (${value.length} characters) — drag to select`}
      >
        {value}
      </code>
      <button
        type="button"
        className="copy-btn"
        onClick={onCopy}
        title={copied ? "Copied!" : "Copy to clipboard"}
        aria-label={copied ? "Copied" : "Copy sequence to clipboard"}
      >
        {/* Inline SVG clipboard icon — `currentColor` so it tracks the
            button's text colour through theme + hover transitions. */}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <rect
            x="3.25"
            y="4.25"
            width="8.5"
            height="9.5"
            rx="1.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          />
          <rect
            x="5.5"
            y="2"
            width="4"
            height="2.5"
            rx="0.6"
            fill="currentColor"
          />
        </svg>
        {copied && <span className="copy-btn-feedback">copied</span>}
      </button>
    </div>
  );
}

function SimDataTab({ manifest, snapshot, source, onLoadSimulation, onNewSimulation }: InfoPanelProps) {
  // Dropdown state for the "New ▾" button.
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown when the user clicks outside it.
  useEffect(() => {
    if (!newMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [newMenuOpen]);

  // Download the current manifest as a .json file.
  const handleDownload = () => {
    const safeName = manifest.metadata.sequence_name
      .replace(/[^\w\-]/g, "_").slice(0, 60) || "simulation";
    const safeTime = manifest.metadata.created_at.slice(0, 19).replace(/[^\w\-]/g, "_");
    const filename = `${safeName}_${safeTime}.json`;
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const { metadata, promoter, params, terminator, sequence } = manifest;
  // The terminator block is computed post-hoc on the *final* RNA, so we
  // slice the final snapshot's transcript rather than the currently-
  // playing one — otherwise the stem/U-tract readout would be blank
  // until the playhead walked past the terminator.
  const finalRna =
    manifest.snapshots.length > 0
      ? manifest.snapshots[manifest.snapshots.length - 1].rna_sequence
      : "";
  const hasUtract =
    terminator !== undefined &&
    terminator.u_tract_end > terminator.u_tract_start;

  return (
    <>
      <section className="sim-data-actions">
        {/* Load */}
        {onLoadSimulation && (
          <button
            type="button"
            className="sim-icon-btn"
            onClick={onLoadSimulation}
            title="Load simulation file…"
            aria-label="Load simulation file"
          >
            {/* Folder + up-arrow (load) icon */}
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none"
                 stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
                 aria-hidden="true">
              <path d="M1.5 5.5h4l1 1.5h7.5v6.5h-12.5z" />
              <line x1="8" y1="5" x2="8" y2="10" />
              <polyline points="5.5,7 8,4.5 10.5,7" />
            </svg>
          </button>
        )}

        {/* New ▾ dropdown */}
        {onNewSimulation && (
          <div className="new-sim-wrap" ref={newMenuRef}>
            <button
              type="button"
              className="sim-icon-btn new-sim-trigger"
              onClick={() => setNewMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              title="New simulation…"
              aria-label="New simulation"
            >
              {/* Plus icon */}
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none"
                   stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
                   aria-hidden="true">
                <line x1="8" y1="3" x2="8" y2="13" />
                <line x1="3" y1="8" x2="13" y2="8" />
              </svg>
              <span className="new-sim-chevron" aria-hidden="true">
                {newMenuOpen ? "▴" : "▾"}
              </span>
            </button>

            {newMenuOpen && (
              <div className="new-sim-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="new-sim-menu-item"
                  onClick={() => {
                    setNewMenuOpen(false);
                    onNewSimulation("create");
                  }}
                >
                  Create new
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="new-sim-menu-item"
                  onClick={() => {
                    setNewMenuOpen(false);
                    onNewSimulation("clone");
                  }}
                >
                  Clone current
                </button>
              </div>
            )}
          </div>
        )}

        {/* Download */}
        <button
          type="button"
          className="sim-icon-btn"
          onClick={handleDownload}
          title="Download current simulation as JSON"
          aria-label="Download simulation JSON"
        >
          {/* Download arrow icon */}
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none"
               stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
               aria-hidden="true">
            <line x1="8" y1="2" x2="8" y2="10.5" />
            <polyline points="4.5,7.5 8,11 11.5,7.5" />
            <line x1="2.5" y1="14" x2="13.5" y2="14" />
          </svg>
        </button>
      </section>

      <section>
        <h3>Run</h3>
        <dl>
          <dt>Name</dt>
          <dd>{metadata.sequence_name}</dd>
          <dt>Created</dt>
          <dd>{new Date(metadata.created_at).toLocaleString()}</dd>
          {source && (
            <>
              <dt>File</dt>
              <dd><code className="sim-filename">{source}</code></dd>
            </>
          )}
          <dt>Seed</dt>
          <dd>{metadata.random_seed ?? "—"}</dd>
          <dt>Frames</dt>
          <dd>{metadata.total_frames}</dd>
          <dt>Duration</dt>
          <dd>{metadata.total_time_s.toFixed(2)} s</dd>
          {/* Coding strand sits under Duration as a single-line, clipped,
              selectable readout with a copy-to-clipboard affordance.
              "Base pairs" follows it (full label rather than the "bp"
              abbreviation that used to live in the page header). */}
          <dt>Sequence</dt>
          <dd>
            <CopyableSequence
              value={sequence.coding_strand}
              label="Coding strand"
            />
          </dd>
          <dt>Base pairs</dt>
          <dd>{sequence.sequence_length}</dd>
        </dl>
      </section>

      <section>
        <h3>Promoter</h3>
        <dl>
          <dt>Score</dt>
          <dd>{(promoter.promoter_score * 100).toFixed(1)}%</dd>
          <dt>-35</dt>
          <dd>
            <code>{promoter.hexamer_35}</code>
            {" @ "}
            {promoter.pos_35}
          </dd>
          <dt>-10</dt>
          <dd>
            <code>{promoter.hexamer_10}</code>
            {" @ "}
            {promoter.pos_10}
          </dd>
          <dt>Spacer</dt>
          <dd>{promoter.spacer_len} bp</dd>
          <dt>Extended -10</dt>
          <dd>{promoter.extended_minus10 ? "yes (TG motif)" : "no"}</dd>
          <dt>W433 contacts</dt>
          <dd>
            <code>{promoter.w433_contacts}</code>
          </dd>
        </dl>
      </section>

      {terminator && (
        <section>
          <h3>Termination</h3>
          <dl>
            <dt>Hairpin ΔG</dt>
            <dd>{terminator.hairpin_dg.toFixed(2)} kcal/mol</dd>
            <dt>5′ stem</dt>
            <dd>
              <code>
                {finalRna.slice(terminator.stem5_start, terminator.stem5_end)}
              </code>{" "}
              ({terminator.stem_len} nt)
            </dd>
            <dt>Loop</dt>
            <dd>
              <code>
                {finalRna.slice(terminator.loop_start, terminator.loop_end)}
              </code>{" "}
              ({terminator.loop_len} nt)
            </dd>
            <dt>3′ stem</dt>
            <dd>
              <code>
                {finalRna.slice(terminator.stem3_start, terminator.stem3_end)}
              </code>
            </dd>
            <dt>U-tract</dt>
            <dd>
              {hasUtract ? (
                <>
                  <code>
                    {finalRna.slice(
                      terminator.u_tract_start,
                      terminator.u_tract_end,
                    )}
                  </code>{" "}
                  ({(terminator.u_tract_fraction * 100).toFixed(0)}% A/U)
                </>
              ) : (
                <em>none detected</em>
              )}
            </dd>
          </dl>
        </section>
      )}

      <section>
        <h3>Conditions</h3>
        <dl>
          <dt>Temperature</dt>
          <dd>{params.temperature_c} °C</dd>
          <dt>NTP (µM)</dt>
          <dd>
            {Object.entries(params.ntp_conc_uM)
              .map(([n, v]) => `${n}: ${v}`)
              .join(", ")}
          </dd>
          <dt>GreB</dt>
          <dd>{params.greb_conc_uM} µM</dd>
          <dt>Rho</dt>
          <dd>{params.rho_enabled ? "enabled" : "disabled"}</dd>
        </dl>
      </section>

      <section>
        <h3>Kinetics</h3>
        <dl>
          <dt>Elongation rate</dt>
          <dd>{params.k_cat} s⁻¹</dd>
          <dt>Abortive prob.</dt>
          <dd>
            {params.p_abortive_base} base,{" "}
            {params.abortive_decay} decay / nt
          </dd>
          <dt>Escape length</dt>
          <dd>{params.escape_length} nt</dd>
          <dt>Hairpin ΔG threshold</dt>
          <dd>{params.hairpin_dg_threshold} kcal/mol</dd>
        </dl>
      </section>

      <section>
        <h3>Current state</h3>
        <dl>
          <dt>Position</dt>
          <dd>
            {snapshot.position >= 0 ? "+" : ""}
            {snapshot.position}
          </dd>
          <dt>Bubble</dt>
          <dd>
            {snapshot.bubble_upstream} → {snapshot.bubble_downstream} ({snapshot.bubble_size} nt)
          </dd>
          <dt>Scrunch</dt>
          <dd>{snapshot.scrunch_nt} nt</dd>
          <dt>W433 depth</dt>
          <dd>
            <meter min={0} max={1} value={snapshot.w433_depth} />
            {" "}
            {(snapshot.w433_depth * 100).toFixed(0)}%
          </dd>
          <dt>Backtrack</dt>
          <dd>
            {snapshot.backtrack_steps} nt
            {snapshot.is_arrested ? " · arrested" : ""}
            {snapshot.greb_active ? " · GreB active" : ""}
          </dd>
        </dl>
      </section>

      {snapshot.events.length > 0 && (
        <section>
          <h3>Events</h3>
          <ul className="events">
            {snapshot.events.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Info (stub)                                                        */
/* ------------------------------------------------------------------ */

function InfoTab() {
  return (
    <>
      {/* ── About ──────────────────────────────────────────────── */}
      <section>
        <h3>About this application</h3>
        <p>
          Hi, I'm Mark Roper…{" "}
          <em className="about-placeholder">(more to come here)</em>
        </p>
      </section>

      {/* ── How transcription works ────────────────────────────── */}
      <section>
        <h3>How bacterial transcription works</h3>
        <p>
          Transcription is the process by which a DNA template is read and
          converted into messenger RNA (mRNA). In bacteria, this is
          performed by a single multi-subunit enzyme — RNA polymerase (RNAP,
          core: α₂ββ′ω) — together with a dissociable initiation factor
          called σ⁷⁰ (sigma-70). The σ⁷⁰ subunit confers promoter
          specificity; once bound to RNAP it forms the holoenzyme (α₂ββ′ωσ)
          that can locate and open a promoter [1].
        </p>
        <p>
          The full cycle proceeds through four broad stages, each animated
          in this visualiser.
        </p>

        <h4 className="about-stage">1 · Initiation — finding and opening the promoter</h4>
        <p>
          The holoenzyme diffuses along the DNA until σ⁷⁰ region 4 contacts
          the −35 hexamer and region 2 contacts the −10 hexamer of a
          σ⁷⁰-class promoter. This forms the closed complex (RPc). The
          enzyme then isomerises to the open complex (RPo): ≈ 13 bp of DNA
          are melted, and the tryptophan residue W433 in σ⁷⁰ region 2.3
          intercalates between bases −11 and −12 to stabilise the
          single-stranded bubble [4, 9]. RPo formation is the
          rate-limiting step for most promoters [6].
        </p>
        <p>
          Once the bubble is open, RNAP begins synthesising short RNA
          transcripts (2–9 nt). Because σ⁷⁰ anchors the complex at the
          −10 element, RNAP cannot translocate; instead it reels downstream
          DNA into the body — a process called <em>scrunching</em> — storing
          elastic strain that will drive promoter escape [5].
        </p>

        <h4 className="about-stage">2 · Promoter escape and σ⁷⁰ release</h4>
        <p>
          Most short transcripts are aborted and released; the RNA is
          extruded while the bubble resets. When the nascent RNA exceeds
          ≈ 9–11 nt the accumulated scrunching strain overcomes the σ
          contacts and RNAP breaks free of the promoter. σ⁷⁰ dissociates
          (promoter escape), leaving the core elongation complex to
          translocate processively downstream.
        </p>

        <h4 className="about-stage">3 · Elongation — processive RNA synthesis</h4>
        <p>
          During elongation, RNAP maintains a 13 bp transcription bubble and
          an 8–9 bp RNA:DNA hybrid inside its active-site cleft [1, 2]. At
          each register the incoming NTP is selected by base-pairing with
          the template strand and incorporated by the catalytic Mg²⁺. The
          rate is sequence-dependent, governed by RNA:DNA hybrid stability
          via nearest-neighbour thermodynamics [13]. RNAP can transiently
          pause at certain sequence motifs and may backtrack — sliding
          upstream by 1 or more nucleotides — which sequesters the 3′ end
          of the RNA in a secondary channel. Backtracked complexes can
          become arrested; the transcript cleavage factor GreB rescues
          arrest by stimulating hydrolysis of the 3′ RNA, generating a new
          3′-OH for re-extension [4, 11].
        </p>

        <h4 className="about-stage">4 · Termination — releasing RNA and DNA</h4>
        <p>
          Two termination pathways are modelled. <em>Intrinsic termination</em>{" "}
          is driven by a GC-rich RNA hairpin followed by a poly-U tract in
          the nascent transcript. The hairpin folds in the RNA exit channel,
          and the weak rU:dA hybrid in the U-tract melts, releasing RNA and
          RNAP without any additional factors [7, 8]. <em>Rho-dependent
          termination</em> involves the Rho helicase tracking the nascent
          RNA and displacing RNAP at a pause site; this pathway is modelled
          in the simulation engine but is not the default for the demo
          sequence.
        </p>
      </section>

      {/* ── Timeline states ────────────────────────────────────── */}
      <section>
        <h3>Timeline states explained</h3>

        <h4 className="about-stage">σ⁷⁰ lane</h4>
        <dl>
          <dt>Approaching</dt>
          <dd>
            σ⁷⁰ and core RNAP assemble in solution and descend to the
            promoter as a pre-formed holoenzyme.
          </dd>
          <dt>Bound</dt>
          <dd>
            The holoenzyme is docked on the promoter in the closed
            complex. σ region 4 contacts −35; region 2 contacts −10.
            W433 has not yet inserted.
          </dd>
          <dt>W433 inserting</dt>
          <dd>
            Tryptophan-433 in σ region 2.3 is actively intercalating
            between bases −11 and −12, driving DNA melting and bubble
            opening.
          </dd>
          <dt>W433 intercalated</dt>
          <dd>
            W433 is fully wedged in. The transcription bubble is open
            (RPo). The complex is now competent for initial
            RNA synthesis.
          </dd>
          <dt>Releasing</dt>
          <dd>
            Promoter escape is in progress. σ⁷⁰ contacts are breaking
            as the elongating RNA exceeds the length that σ1.1 can
            accommodate. RNAP is transitioning to the core elongation
            complex.
          </dd>
          <dt>Released</dt>
          <dd>
            σ⁷⁰ has fully dissociated. RNAP is now a processive core
            enzyme and σ⁷⁰ is free to re-associate with another core
            for a new round of initiation.
          </dd>
        </dl>

        <h4 className="about-stage">RNAP lane</h4>
        <dl>
          <dt>Approaching</dt>
          <dd>
            Holoenzyme assembly and promoter search. No RNA synthesis.
          </dd>
          <dt>Initiation</dt>
          <dd>
            Closed complex on the promoter. DNA melting (isomerisation
            RPc → RPo) has not yet completed.
          </dd>
          <dt>Open complex</dt>
          <dd>
            Transcription bubble is fully open (≈ 13 bp). First NTPs
            are incorporated; short abortive transcripts are produced.
          </dd>
          <dt>Scrunching</dt>
          <dd>
            RNAP is held at the TSS by σ contacts while pulling
            downstream DNA into the body. The bubble grows as
            scrunched DNA accumulates. Abortive release is most
            likely here.
          </dd>
          <dt>Elongation</dt>
          <dd>
            Processive NTP incorporation after promoter escape.
            σ⁷⁰ has been released; RNAP translocates one base per
            incorporation cycle.
          </dd>
          <dt>Paused</dt>
          <dd>
            RNAP has entered an elemental pause — translocation is
            stalled at a sequence-specific register. No net synthesis.
            The enzyme can resume spontaneously or backtrack.
          </dd>
          <dt>Backtracked</dt>
          <dd>
            RNAP has slid upstream by one or more nucleotides. The
            3′ end of the RNA is extruded into the secondary channel.
            GreB (if present) can stimulate RNA cleavage to rescue
            the complex.
          </dd>
          <dt>Terminated</dt>
          <dd>
            RNAP has stalled at the intrinsic termination site on the
            U-tract. The RNA hairpin is forming in the exit channel,
            destabilising the hybrid.
          </dd>
          <dt>Detaching</dt>
          <dd>
            Post-termination: the RNA:DNA hybrid has melted, the
            transcription bubble is re-annealing, and RNAP lifts off
            the DNA. The completed RNA transcript is released.
          </dd>
        </dl>
      </section>

      {/* ── Simulation design ──────────────────────────────────── */}
      <section>
        <h3>Simulation design and published sources</h3>
        <p>
          The simulation is a kinetic Monte Carlo (KMC / Gillespie-style)
          engine in which each mechanistic step is represented as a
          first- or second-order rate process. The rates and structural
          geometry were drawn from the following published work.
        </p>

        <h4 className="about-stage">Promoter recognition and open complex</h4>
        <p>
          The −35/−10 promoter scoring uses consensus hexamers from the
          σ⁷⁰ structural literature [4, 9]. The rate of closed-to-open
          complex isomerisation (k<sub>open</sub> = 0.04 s⁻¹ at a strong
          promoter) follows Kapanidis et al. [6]. W433 intercalation depth
          is animated as a continuous variable driven by the open-complex
          isomerisation fraction.
        </p>

        <h4 className="about-stage">Scrunching and abortive initiation</h4>
        <p>
          DNA scrunching — the reeling of downstream DNA into the RNAP
          body while σ anchors the upstream bubble edge — was demonstrated
          by single-molecule FRET [5]. The engine pins
          <code>bubble_upstream</code> at −11 during scrunching while
          extending <code>bubble_downstream</code> each synthesis step,
          matching the observed constant upstream / growing downstream
          bubble geometry. Abortive probability decays exponentially with
          transcript length, consistent with the measured escape-length
          distribution.
        </p>

        <h4 className="about-stage">Elongation kinetics</h4>
        <p>
          The base NTP incorporation rate (k<sub>cat</sub>) follows
          single-molecule optical-trap measurements at physiological NTP
          concentrations [1, 2]. Incorporation is modulated by RNA:DNA
          hybrid stability using nearest-neighbour parameters from
          Sugimoto et al. [13], and by NTP Michaelis–Menten kinetics
          following Bai et al. [12].
        </p>

        <h4 className="about-stage">Pausing and backtracking</h4>
        <p>
          Elemental pausing is treated as a stochastic branch competing
          with each translocation step; pause entry and exit rates are
          from Larson et al. [2]. Backtracking follows Nudler et al. [3]:
          once paused, RNAP may slide backwards with a rate that decreases
          with increasing hybrid stability at the 3′ end. Arrested
          complexes are rescued by GreB-stimulated RNA cleavage at a rate
          calibrated to Erie et al. [11].
        </p>

        <h4 className="about-stage">Intrinsic termination</h4>
        <p>
          Termination is triggered when the thermodynamic stability of the
          hairpin (ΔG, computed with Turner & Mathews nearest-neighbour
          parameters [14]) exceeds the threshold and the downstream U-tract
          fraction is sufficient. The temporal ordering — pause on U-tract,
          hairpin nucleation, then bubble collapse — follows the sequential
          mechanism of Yarnell & Roberts [7] and the force-clamp kinetics
          of Larson et al. [2]. The hairpin target geometry (loop apex
          pointing away from RNAP, hairpin axis parallel to the upstream
          duplex) is based on the three cryo-EM intermediate structures of
          You et al. [8].
        </p>

        <h4 className="about-stage">3D scene geometry</h4>
        <p>
          The RNAP subunit layout (α₂ at the back, β below the cleft,
          β′ above, ω adjacent to β′) follows the reviews by Murakami [1,
          9] and the elongation complex schematics of Santangelo &
          Artsimovitch [1]. The transcription bubble extent (13 bp) and
          RNA:DNA hybrid length (9 bp) are from Vassylyev et al. [16] and
          corroborated by the <em>E. coli</em> cryo-EM of Kang et al. [10].
          The RNA exit channel direction is placed between the β-flap and
          the β′-clamp per [1]. The σ⁷⁰ four-region topology (σ4 at −35,
          σ3 in the spacer, σ2 at −10, σ1.1 inside the cleft) and the
          W433 wedge site are from Murakami 2013 [4].
        </p>
        <p>
          The atomic model overlay uses PDB entry 6ALF (
          <em>E. coli</em> RNAP σ⁷⁰ holoenzyme), rendered in the browser
          using 3Dmol.js [15].
        </p>
      </section>

      {/* ── References ─────────────────────────────────────────── */}
      <section>
        <h3>References</h3>
        <ol className="about-refs">
          <li>
            Santangelo, T. J. &amp; Artsimovitch, I. Termination and
            antitermination: RNA polymerase runs a stop sign.{" "}
            <em>Nat Rev Microbiol</em> 9, 319–329 (2011).{" "}
            <a href="https://doi.org/10.1038/nrmicro2560" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1038/nrmicro2560</a>
          </li>
          <li>
            Larson, M. H., Greenleaf, W. J., Landick, R. &amp; Block,
            S. M. Applied force reveals mechanistic and energetic details
            of transcription termination.{" "}
            <em>Cell</em> 132, 971–982 (2008).{" "}
            <a href="https://doi.org/10.1016/j.cell.2008.01.027" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1016/j.cell.2008.01.027</a>
          </li>
          <li>
            Nudler, E., Mustaev, A., Lukhtanov, E. &amp; Goldfarb, A. The
            RNA-DNA hybrid maintains the register of transcription by
            preventing backtracking of RNA polymerase.{" "}
            <em>Cell</em> 89, 33–41 (1997).{" "}
            <a href="https://doi.org/10.1016/S0092-8674(00)80180-4" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1016/S0092-8674(00)80180-4</a>
          </li>
          <li>
            Murakami, K. S. The X-ray crystal structure of{" "}
            <em>Escherichia coli</em> RNA polymerase σ⁷⁰ holoenzyme.{" "}
            <em>J Biol Chem</em> 288, 9126–9134 (2013).{" "}
            <a href="https://doi.org/10.1074/jbc.M113.453191" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1074/jbc.M113.453191</a>
          </li>
          <li>
            Revyakin, A., Liu, C., Ebright, R. H. &amp; Strick, T. R.
            Abortive initiation and productive initiation by RNA polymerase
            involve DNA scrunching.{" "}
            <em>Science</em> 314, 1139–1143 (2006).{" "}
            <a href="https://doi.org/10.1126/science.1131398" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1126/science.1131398</a>
          </li>
          <li>
            Kapanidis, A. N. <em>et al.</em> Initial transcription by RNA
            polymerase proceeds through a DNA-scrunching mechanism.{" "}
            <em>Science</em> 314, 1144–1147 (2006).{" "}
            <a href="https://doi.org/10.1126/science.1131399" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1126/science.1131399</a>
          </li>
          <li>
            Yarnell, W. S. &amp; Roberts, J. W. Mechanism of intrinsic
            transcription termination and antitermination.{" "}
            <em>Science</em> 284, 611–615 (1999).{" "}
            <a href="https://doi.org/10.1126/science.284.5414.611" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1126/science.284.5414.611</a>
          </li>
          <li>
            You, L. <em>et al.</em> Structural basis for intrinsic
            transcription termination.{" "}
            <em>Nature</em> 613, 783–789 (2023).{" "}
            <a href="https://doi.org/10.1038/s41586-022-05604-1" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1038/s41586-022-05604-1</a>
          </li>
          <li>
            Murakami, K. S. Structural biology of bacterial RNA polymerase.{" "}
            <em>Biomolecules</em> 5, 848–864 (2015).{" "}
            <a href="https://doi.org/10.3390/biom5020848" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.3390/biom5020848</a>
          </li>
          <li>
            Kang, J. Y. <em>et al.</em> Structural basis of transcription
            elongation by{" "}
            <em>Escherichia coli</em> RNA polymerase.{" "}
            <em>eLife</em> 6:e25478 (2017).{" "}
            <a href="https://doi.org/10.7554/eLife.25478" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.7554/eLife.25478</a>
          </li>
          <li>
            Erie, D. A., Hajiseyedjavadi, O., Young, M. C. &amp; von
            Hippel, P. H. Multiple RNA polymerase conformations and GreA:
            control of the fidelity of transcription.{" "}
            <em>Science</em> 262, 867–873 (1993).{" "}
            <a href="https://doi.org/10.1126/science.8235608" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1126/science.8235608</a>
          </li>
          <li>
            Bai, L., Shundrovsky, A. &amp; Wang, M. D.
            Sequence-dependent kinetic model for transcription elongation
            by RNA polymerase.{" "}
            <em>J Mol Biol</em> 344, 335–349 (2004).{" "}
            <a href="https://doi.org/10.1016/j.jmb.2004.08.107" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1016/j.jmb.2004.08.107</a>
          </li>
          <li>
            Sugimoto, N. <em>et al.</em> Thermodynamic parameters to
            predict stability of RNA/DNA hybrid duplexes.{" "}
            <em>Biochemistry</em> 34, 11211–11216 (1995).{" "}
            <a href="https://doi.org/10.1021/bi00035a029" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1021/bi00035a029</a>
          </li>
          <li>
            Turner, D. H. &amp; Mathews, D. H. NNDB: the nearest neighbor
            parameter database for predicting stability of nucleic acid
            secondary structure.{" "}
            <em>Nucleic Acids Res</em> 38 (Database issue), D280–D282
            (2010).{" "}
            <a href="https://doi.org/10.1093/nar/gkp892" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1093/nar/gkp892</a>
          </li>
          <li>
            Rego, N. &amp; Koes, D. 3Dmol.js: molecular visualization
            with WebGL.{" "}
            <em>Bioinformatics</em> 31, 1322–1324 (2015).{" "}
            <a href="https://doi.org/10.1093/bioinformatics/btu829" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1093/bioinformatics/btu829</a>
          </li>
          <li>
            Vassylyev, D. G. <em>et al.</em> Structural basis for
            transcription elongation by bacterial RNA polymerase.{" "}
            <em>Nature</em> 448, 157–162 (2007).{" "}
            <a href="https://doi.org/10.1038/nature05932" target="_blank" rel="noopener noreferrer" className="about-doi">doi:10.1038/nature05932</a>
          </li>
        </ol>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Help                                                               */
/* ------------------------------------------------------------------ */

function HelpTab() {
  return (
    <>
      <section>
        <h3>Overview</h3>
        <p>
          DNA to RNA Transcription Visualiser replays a mechanistic bacterial
          transcription simulation frame by frame. Use the timeline at the
          bottom to scrub or play back the simulation, the 3D viewer to watch
          the enzyme in action, and the sequence panel to follow the DNA/RNA
          read-out with promoter, bubble, and terminator annotations.
        </p>
      </section>

      <section>
        <h3>Keyboard shortcuts</h3>
        <dl>
          <dt><kbd>Space</kbd></dt>
          <dd>Play / pause</dd>
          <dt><kbd>←</kbd> <kbd>→</kbd></dt>
          <dd>Step one frame</dd>
          <dt><kbd>Shift</kbd> + <kbd>←</kbd> <kbd>→</kbd></dt>
          <dd>Step ten frames</dd>
          <dt><kbd>Home</kbd> / <kbd>End</kbd></dt>
          <dd>Jump to first / last frame</dd>
        </dl>
      </section>

      <section>
        <h3>Timeline</h3>
        <p>
          The two coloured lanes show the σ⁷⁰ state (top) and the RNAP
          phase (bottom) across all frames. The scrubber below them lets
          you drag to any frame. When playback reaches the last frame the
          play button changes to <strong>↺</strong> — clicking it restarts
          from frame 0. Use the speed slider to adjust the playback rate.
        </p>
      </section>

      <section>
        <h3>Sequence panel</h3>
        <p>
          Toggle between coding (+), template (−), or both strands. The
          coordinate ruler above the bases is scaled to match each base
          position. Turn off <em>follow RNAP</em> to scroll freely without
          the view re-centring each frame. Coloured chips in the legend
          explain each highlight — the hairpin and U-tract annotations only
          appear once RNAP has transcribed past the 3′ stem.
        </p>
      </section>

      <section>
        <h3>3D viewer</h3>
        <p>
          Click and drag to orbit, scroll to zoom. Use <em>'Reset view'</em> in
          the legend bar to return to the initial orientation. Click any
          legend chip to hide or show that component.
        </p>
        <p>
          The <em>render</em> button (top-right of the canvas) controls
          how each component is drawn:
        </p>
        <dl>
          <dt>schematic</dt>
          <dd>
            Procedural cartoon — fast, always available. σ⁷⁰ in schematic
            mode shows only the two most relevant contacts: region 4
            (recognises the −35 hexamer) and region 2 (recognises the −10
            hexamer / W433 wedge site).
          </dd>
          <dt>regions</dt>
          <dd>
            Detailed rigid-body mesh for σ⁷⁰ and RNAP subunits, with
            on-canvas labels available via the <em>Labels</em> toggle.
            Available for σ⁷⁰ / W433 and RNAP only.
          </dd>
          <dt>atomic</dt>
          <dd>
            Per-residue heavy-atom detail for the three nucleic-acid strands
            (coding, template, nascent RNA). Use the <em>Molecular /
            Cartoon / Both</em> pill in the legend to switch between
            ball-and-stick, backbone ribbon, or both. Not available for
            σ⁷⁰ or RNAP.
          </dd>
        </dl>
      </section>

      <section>
        <h3>Loading simulations</h3>
        <p>
          Use the <em>Load</em> icon (📁) in the Sim Data tab to swap in a
          different simulation manifest — either by pasting a URL or
          dragging a local <code>.json</code> file. Use <em>New ▾</em> to
          author a fresh run or clone the current one, then send it to a
          local RNASim server or download the config for the CLI.
        </p>
      </section>
    </>
  );
}
