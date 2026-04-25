import { useCallback, useEffect, useRef, useState } from "react";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import type { NewSimMode } from "./NewSimulationDialog";

interface InfoPanelProps {
  manifest: SimulationManifest;
  snapshot: Snapshot;
  /** Opens the Load Simulation File modal.  Owned by App so the modal
   *  itself lives above the grid instead of inside the info panel. */
  onLoadSimulation?: () => void;
  /** Opens the New Simulation modal in create or clone mode. */
  onNewSimulation?: (mode: NewSimMode) => void;
}

type InfoTab = "sim" | "info" | "help";

const TABS: Array<{ id: InfoTab; label: string }> = [
  { id: "sim",  label: "Sim Data" },
  { id: "info", label: "Info" },
  { id: "help", label: "Help" },
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
export function InfoPanel({ manifest, snapshot, onLoadSimulation, onNewSimulation }: InfoPanelProps) {
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

function SimDataTab({ manifest, snapshot, onLoadSimulation, onNewSimulation }: InfoPanelProps) {
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
    <section className="info-stub">
      <h3>Info</h3>
      <p>
        Reference material will live here — publication links, mechanism
        diagrams, and a glossary of the kinetic states shown in the viewer.
      </p>
      <p className="info-stub-note">
        <em>Not wired up yet.</em>
      </p>
    </section>
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
          rnasim replays a mechanistic bacterial transcription simulation
          frame by frame. Use the timeline at the bottom to scrub or play,
          the 3D viewer to watch the enzyme, and the sequence panel to
          follow the DNA/RNA read-out with promoter, bubble, and
          terminator annotations.
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
        <h3>Sequence panel</h3>
        <p>
          Toggle between coding, template, or both strands. Turn off
          <em> follow RNAP</em> to scroll freely without the view
          re-centring each frame. Colored chips above the grid explain
          each highlight — the hairpin and U-tract only appear once
          RNAP has transcribed past the 3′ stem.
        </p>
      </section>

      <section>
        <h3>3D viewer</h3>
        <p>
          Click and drag to orbit, scroll to zoom. Use <em>Reset view</em>
          in the legend to return to the initial orientation. The render
          options button (top-right) lets you mix schematic and atomic
          rendering on a per-component basis.
        </p>
      </section>
    </>
  );
}
