import { useState } from "react";
import type { SimulationManifest, Snapshot } from "../types/manifest";

interface InfoPanelProps {
  manifest: SimulationManifest;
  snapshot: Snapshot;
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
export function InfoPanel({ manifest, snapshot }: InfoPanelProps) {
  const [tab, setTab] = useState<InfoTab>("sim");

  return (
    <aside className="info-panel">
      <nav className="info-tabs" role="tablist" aria-label="Info panel sections">
        {TABS.map((t) => (
          <button
            key={t.id}
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

      <div className="info-tab-body" role="tabpanel">
        {tab === "sim"  && <SimDataTab manifest={manifest} snapshot={snapshot} />}
        {tab === "info" && <InfoTab />}
        {tab === "help" && <HelpTab />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Sim Data                                                           */
/* ------------------------------------------------------------------ */

function SimDataTab({ manifest, snapshot }: InfoPanelProps) {
  const { metadata, promoter, params } = manifest;

  return (
    <>
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
