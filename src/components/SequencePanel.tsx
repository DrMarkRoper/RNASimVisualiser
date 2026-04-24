import { useEffect, useMemo, useRef, useState } from "react";
import type { SimulationManifest, Snapshot } from "../types/manifest";
import { PHASE_COLORS } from "../utils/phase";
import { getSigma70Presence } from "../utils/sigma";

interface SequencePanelProps {
  manifest: SimulationManifest;
  snapshot: Snapshot;
}

/** Length of the RNA:DNA hybrid under the RNAP active site (nt). */
const HYBRID_LEN = 9;

type StrandView = "coding" | "template" | "both";

/**
 * Annotated DNA/RNA sequence view.
 *
 *   • Horizontal-scrolling monospace grid — every track shares a 1ch column
 *     so coding / template / RNA stay byte-for-byte aligned.
 *   • Strand toggle — coding (+) / template (-) / both.
 *   • Aligned RNA — each synthesised base is printed beneath the coding
 *     column it was transcribed from.
 *   • Hybrid colour — the last HYBRID_LEN RNA nt (those base-paired with the
 *     template inside the bubble) are highlighted separately from already-
 *     released upstream RNA.
 *   • Auto-follow — when enabled, the viewport scrolls to keep the RNAP
 *     column centred as the frame advances.
 */
export function SequencePanel({ manifest, snapshot }: SequencePanelProps) {
  const { coding_strand, template_strand, tss_index, sequence_length } =
    manifest.sequence;
  const { pos_35, pos_10, w433_contacts } = manifest.promoter;

  const [view, setView] = useState<StrandView>("both");
  const [follow, setFollow] = useState(true);

  // Python's manifest stores both strands 5′→3′ (Biopython convention), so
  // template_strand is the reverse-complement of coding_strand. To display it
  // index-aligned under the coding strand (i.e. as a base-pair view), we
  // reverse it once — the result reads 3′→5′ left-to-right, which is the
  // conventional way to depict the template strand below the coding strand.
  const templateAligned = useMemo(
    () => template_strand.split("").reverse().join(""),
    [template_strand],
  );

  /* ---------------- coordinate helpers ---------------- */

  // TSS-relative coordinate of each character index:
  //   i  <  tss_index → negative (i - tss_index)
  //   i ==  tss_index → +1
  //   i  >  tss_index → (i - tss_index + 1)
  const coordOf = (i: number): number => {
    const delta = i - tss_index;
    return delta < 0 ? delta : delta + 1;
  };
  const indexOfCoord = (coord: number): number =>
    coord < 0 ? tss_index + coord : tss_index + coord - 1;

  /* ---------------- annotation ranges ----------------- */

  const m35Range = useMemo(() => {
    const start = indexOfCoord(pos_35);
    return { start, end: start + 5 };
  }, [pos_35, tss_index]);

  const m10Range = useMemo(() => {
    const start = indexOfCoord(pos_10);
    return { start, end: start + 5 };
  }, [pos_10, tss_index]);

  const w433Range = useMemo(() => {
    const start = indexOfCoord(-12); // wedge sits between -11 and -12
    return { start, end: start + 1 };
  }, [tss_index]);

  const bubbleLo = indexOfCoord(snapshot.bubble_upstream);
  const bubbleHi = indexOfCoord(snapshot.bubble_downstream);
  const rnapIdx = indexOfCoord(snapshot.position);

  /* ---------------- terminator annotation -------------- */

  // RNA index k is transcribed from coding-strand column (tss_index + k).
  // The engine only emits `terminator` once an intrinsic termination event
  // has fired, so we additionally gate visibility on the transcript having
  // actually been synthesised past the stem's 3′ arm.  That way the
  // highlight reveals itself as RNAP walks over the terminator instead of
  // popping in from frame 0.
  const terminator = manifest.terminator;
  const termCols = useMemo(() => {
    if (!terminator) return null;
    return {
      stem5_lo: tss_index + terminator.stem5_start,
      stem5_hi: tss_index + terminator.stem5_end - 1,
      loop_lo:  tss_index + terminator.loop_start,
      loop_hi:  tss_index + terminator.loop_end - 1,
      stem3_lo: tss_index + terminator.stem3_start,
      stem3_hi: tss_index + terminator.stem3_end - 1,
      u_lo:     tss_index + terminator.u_tract_start,
      u_hi:     tss_index + terminator.u_tract_end - 1,
      hasU:     terminator.u_tract_end > terminator.u_tract_start,
      // Index past which the terminator annotation becomes visible (i.e.
      // has actually been transcribed).  We use the 3′ stem start so the
      // highlight appears once the stem has begun to fold.
      revealRnaIdx: terminator.stem3_start,
    };
  }, [terminator, tss_index]);
  const termVisible =
    termCols !== null && snapshot.rna_length >= termCols.revealRnaIdx;

  // W433 is a σ⁷⁰ region-2.3 residue; once σ⁷⁰ has released, W433 leaves
  // the scene and the -11/-12 outline on the coding strand should vanish
  // with it. We use the monotonic presence factor so the highlight doesn't
  // resurrect during backtrack/GreB cleavage.
  const sigmaPresence = getSigma70Presence(manifest, snapshot);
  const w433Visible = sigmaPresence > 0.02;

  // RNA base at coding-strand column i (if that column has been transcribed).
  const rnaAt = (i: number): string | null => {
    const k = i - tss_index; // 0-based RNA index
    if (k < 0 || k >= snapshot.rna_sequence.length) return null;
    return snapshot.rna_sequence[k];
  };

  // Hybrid window: last HYBRID_LEN nt of RNA (the 3′ end paired with template).
  const hybridStartRnaIdx = Math.max(0, snapshot.rna_length - HYBRID_LEN);
  const hybridStartCodingIdx = tss_index + hybridStartRnaIdx;
  const hybridEndCodingIdx = tss_index + snapshot.rna_length - 1;
  const isHybridColumn = (i: number): boolean =>
    snapshot.rna_length > 0 &&
    i >= hybridStartCodingIdx &&
    i <= hybridEndCodingIdx;

  /* ---------------- auto-follow ----------------------- */

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rnapMarkerRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!follow) return;
    const marker = rnapMarkerRef.current;
    if (!marker) return;
    marker.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [follow, rnapIdx]);

  /* ---------------- ruler ticks ----------------------- */

  // Render "+10", "+20" … every 10 nt, right-aligned over the base they sit
  // above. We space the labels using 1ch-wide cells so they line up perfectly.
  const rulerCells = useMemo(() => {
    const out: Array<{ key: number; text: string }> = [];
    for (let i = 0; i < sequence_length; i++) {
      const coord = coordOf(i);
      // Show label every 10, plus at TSS (+1).
      if (coord === 1 || coord % 10 === 0) {
        const label = `${coord > 0 ? "+" : ""}${coord}`;
        out.push({ key: i, text: label });
      }
    }
    return out;
  }, [sequence_length, tss_index]);

  /* ---------------- render helpers -------------------- */

  const dnaClassFor = (i: number): string => {
    const inM35 = i >= m35Range.start && i <= m35Range.end;
    const inM10 = i >= m10Range.start && i <= m10Range.end;
    const inW433 =
      w433Visible && i >= w433Range.start && i <= w433Range.end;
    const inBubble = i >= bubbleLo && i <= bubbleHi;
    const atRnap = i === rnapIdx;
    // Terminator sub-regions (stem 5′ arm, loop, stem 3′ arm, U-tract).
    // They occupy disjoint column ranges, so at most one matches.
    let termCls = "";
    if (termVisible && termCols) {
      if (i >= termCols.stem5_lo && i <= termCols.stem5_hi) termCls = "term-stem5";
      else if (i >= termCols.loop_lo && i <= termCols.loop_hi) termCls = "term-loop";
      else if (i >= termCols.stem3_lo && i <= termCols.stem3_hi) termCls = "term-stem3";
      else if (termCols.hasU && i >= termCols.u_lo && i <= termCols.u_hi) termCls = "term-utract";
    }
    return [
      "seq-base",
      inM35 ? "m35" : "",
      inM10 ? "m10" : "",
      inW433 ? "w433" : "",
      inBubble ? "bubble" : "",
      atRnap ? "rnap" : "",
      termCls,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const showCoding = view === "coding" || view === "both";
  const showTemplate = view === "template" || view === "both";

  return (
    <div className="sequence-panel">
      <div className="seq-header">
        <h3>Sequence</h3>

        <div className="strand-toggle">
          {(["coding", "template", "both"] as const).map((v) => (
            <label key={v}>
              <input
                type="radio"
                name="strand-view"
                value={v}
                checked={view === v}
                onChange={() => setView(v)}
              />
              {v === "coding" && "coding (+)"}
              {v === "template" && "template (-)"}
              {v === "both" && "both"}
            </label>
          ))}
        </div>

        <label className="follow-toggle">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          follow RNAP
        </label>

        <div className="legend">
          <span className="legend-chip m35">-35 {manifest.promoter.hexamer_35}</span>
          <span className="legend-chip m10">-10 {manifest.promoter.hexamer_10}</span>
          <span
            className="legend-chip w433"
            style={{ opacity: w433Visible ? 1 : 0.3 }}
            title={
              w433Visible
                ? "W433 wedge intercalated between -12 and -11"
                : "σ⁷⁰ has released — W433 is no longer on the DNA"
            }
          >
            W433 ({w433_contacts})
          </span>
          <span className="legend-chip bubble">bubble</span>
          <span className="legend-chip rna-released">RNA released</span>
          <span className="legend-chip rna-hybrid">RNA:DNA hybrid</span>
          {termCols && (
            <>
              <span
                className="legend-chip term-stem"
                style={{ opacity: termVisible ? 1 : 0.3 }}
                title={
                  terminator
                    ? `Terminator hairpin: ${terminator.stem_len} bp stem / ` +
                      `${terminator.loop_len} nt loop, ΔG = ${terminator.hairpin_dg.toFixed(1)} kcal/mol`
                    : undefined
                }
              >
                hairpin{terminator ? ` (ΔG ${terminator.hairpin_dg.toFixed(1)})` : ""}
              </span>
              {termCols.hasU && (
                <span
                  className="legend-chip term-utract"
                  style={{ opacity: termVisible ? 1 : 0.3 }}
                  title={
                    terminator
                      ? `U-tract: ${(terminator.u_tract_fraction * 100).toFixed(0)}% A/U`
                      : undefined
                  }
                >
                  U-tract
                </span>
              )}
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="seq-scroll">
        <div className="seq-tracks" style={{ width: `${sequence_length}ch` }}>
          {/* Coordinate ruler */}
          <div className="seq-track ruler" aria-hidden="true">
            {rulerCells.map((c) => (
              <span
                key={c.key}
                className="ruler-tick"
                style={{ left: `${c.key}ch` }}
              >
                {c.text}
              </span>
            ))}
          </div>

          {/* Coding strand (5′→3′) */}
          {showCoding && (
            <div className="seq-track coding">
              <span className="strand-end-label strand-end-label-left" aria-hidden="true">
                5′
              </span>
              <span className="strand-end-label strand-end-label-right" aria-hidden="true">
                3′
              </span>
              {Array.from(coding_strand).map((base, i) => {
                const cls = dnaClassFor(i);
                const coord = coordOf(i);
                return (
                  <span
                    key={i}
                    className={cls}
                    title={`coding ${coord >= 0 ? "+" : ""}${coord}: ${base}`}
                    ref={i === rnapIdx ? rnapMarkerRef : undefined}
                  >
                    {base}
                  </span>
                );
              })}
            </div>
          )}

          {/* Base-pair bridge (only when both strands shown) */}
          {view === "both" && (
            <div className="seq-track pair" aria-hidden="true">
              {Array.from(coding_strand).map((_, i) => {
                const inBubble = i >= bubbleLo && i <= bubbleHi;
                return (
                  <span key={i} className="seq-base pair-tick">
                    {inBubble ? " " : "|"}
                  </span>
                );
              })}
            </div>
          )}

          {/* Template strand (3′→5′, index-aligned under coding so each
              column reads as a proper base pair). */}
          {showTemplate && (
            <div className="seq-track template">
              <span className="strand-end-label strand-end-label-left" aria-hidden="true">
                3′
              </span>
              <span className="strand-end-label strand-end-label-right" aria-hidden="true">
                5′
              </span>
              {Array.from(templateAligned).map((base, i) => {
                const cls = dnaClassFor(i);
                const coord = coordOf(i);
                return (
                  <span
                    key={i}
                    className={cls}
                    title={`template ${coord >= 0 ? "+" : ""}${coord}: ${base}`}
                    ref={
                      !showCoding && i === rnapIdx ? rnapMarkerRef : undefined
                    }
                  >
                    {base}
                  </span>
                );
              })}
            </div>
          )}

          {/* Aligned RNA track. Empty cells rendered as &nbsp; to preserve
              column alignment. A 5′ label sits one column left of the first
              RNA nt (which is transcribed from the TSS column) — hidden
              until at least one base has been synthesised, otherwise the
              prefix sits dangling over an empty row. */}
          <div className="seq-track rna">
            {snapshot.rna_length > 0 && (
              <span
                className="rna-start-label"
                style={{ left: `${tss_index - 1}ch` }}
                aria-hidden="true"
              >
                5′
              </span>
            )}
            {Array.from(coding_strand).map((_, i) => {
              const r = rnaAt(i);
              if (r === null) {
                return (
                  <span key={i} className="seq-base rna-gap">
                    {"\u00A0"}
                  </span>
                );
              }
              const hybrid = isHybridColumn(i);
              // Terminator overlay on the RNA track — only draw once the
              // feature has actually been transcribed (`termVisible`).
              let termCls = "";
              let termLabel = "";
              if (termVisible && termCols) {
                if (i >= termCols.stem5_lo && i <= termCols.stem5_hi) {
                  termCls = "term-stem5"; termLabel = " · 5′ stem";
                } else if (i >= termCols.loop_lo && i <= termCols.loop_hi) {
                  termCls = "term-loop"; termLabel = " · loop";
                } else if (i >= termCols.stem3_lo && i <= termCols.stem3_hi) {
                  termCls = "term-stem3"; termLabel = " · 3′ stem";
                } else if (termCols.hasU && i >= termCols.u_lo && i <= termCols.u_hi) {
                  termCls = "term-utract"; termLabel = " · U-tract";
                }
              }
              const cls = [
                "seq-base",
                "rna-base",
                hybrid ? "rna-hybrid" : "rna-released",
                termCls,
              ]
                .filter(Boolean)
                .join(" ");
              const coord = coordOf(i);
              return (
                <span
                  key={i}
                  className={cls}
                  title={
                    `RNA +${coord}: ${r}` +
                    (hybrid ? " (RNA:DNA hybrid)" : " (released)") +
                    termLabel
                  }
                >
                  {r}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rna-summary">
        <h4>
          Nascent RNA ({snapshot.rna_length} nt)
          {snapshot.backtrack_steps > 0
            ? ` · backtracked ${snapshot.backtrack_steps} nt`
            : ""}
          {snapshot.is_arrested ? " · arrested" : ""}
          {snapshot.greb_active ? " · GreB active" : ""}
        </h4>
        <pre
          className="rna-seq"
          style={{ borderLeftColor: PHASE_COLORS[snapshot.phase] }}
        >
          {snapshot.rna_sequence || <em>(no RNA synthesised yet)</em>}
        </pre>
      </div>
    </div>
  );
}
