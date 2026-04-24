import type { SimulationManifest, Snapshot, Phase } from "../types/manifest";

/**
 * σ⁷⁰ presence is a *monotonically decreasing* property of simulation time:
 * once the holoenzyme has released σ⁷⁰ during promoter escape, the factor
 * does not come back — even if RNAP backtracks, GreB cleaves, or the
 * position decreases.
 *
 * A pure function of (phase, position) cannot express this correctly because
 * neither field is monotonic (position drops on GreB cleavage; phase toggles
 * between elongation / paused / backtracked). We therefore compute a per-
 * frame array once from the whole manifest and index into it by frame.
 *
 * Anchoring rule:
 *   1. If any snapshot emits an event matching /promoter escape/i, that frame
 *      is the anchor.
 *   2. Otherwise, the first frame whose phase is elongation / paused /
 *      backtracked is the anchor.
 *   3. If no such frame exists, σ⁷⁰ stays bound for the whole run.
 *
 * From the anchor, presence fades linearly from 1.0 to 0.0 over FADE_FRAMES
 * frames. Terminal phases (terminated, aborted) are clamped to 0 regardless
 * of their position in the sequence.
 *
 * FADE_FRAMES was picked to give a visible drift in the 3D scene at typical
 * playback speeds (24 fps) — tune here rather than duplicating elsewhere.
 */
const FADE_FRAMES = 12;

const ESCAPE_EVENT = /promoter escape/i;
const RELEASED_PHASES: ReadonlySet<Phase> = new Set([
  "elongation",
  "paused",
  "backtracked",
  "terminated",
  "aborted",
]);

/**
 * Compute the σ⁷⁰ presence array for a manifest. O(n) in the number of
 * snapshots and called once per manifest load. Callers should memoise by
 * manifest identity.
 */
export function computeSigma70PresenceArray(
  manifest: SimulationManifest,
): Float32Array {
  const n = manifest.snapshots.length;
  const out = new Float32Array(n);

  let anchor = -1;
  for (let i = 0; i < n; i++) {
    const s = manifest.snapshots[i];
    if (s.events.some((e) => ESCAPE_EVENT.test(e))) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) {
    for (let i = 0; i < n; i++) {
      if (RELEASED_PHASES.has(manifest.snapshots[i].phase)) {
        anchor = i;
        break;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    let p: number;
    if (anchor === -1 || i < anchor) {
      p = 1.0;
    } else if (i < anchor + FADE_FRAMES) {
      p = 1.0 - (i - anchor) / FADE_FRAMES;
    } else {
      p = 0.0;
    }
    const phase = manifest.snapshots[i].phase;
    if (phase === "terminated" || phase === "aborted") p = 0;
    out[i] = p;
  }
  return out;
}

/**
 * Per-manifest memoisation so repeated calls during rendering don't rebuild
 * the array.  Keyed on manifest identity (reference equality), which matches
 * how the app holds the parsed manifest in React state.
 */
const presenceCache = new WeakMap<SimulationManifest, Float32Array>();

export function getSigma70Presence(
  manifest: SimulationManifest,
  snapshotOrFrame: Snapshot | number,
): number {
  let arr = presenceCache.get(manifest);
  if (!arr) {
    arr = computeSigma70PresenceArray(manifest);
    presenceCache.set(manifest, arr);
  }
  const frame =
    typeof snapshotOrFrame === "number" ? snapshotOrFrame : snapshotOrFrame.frame;
  if (frame < 0) return arr[0] ?? 1;
  if (frame >= arr.length) return arr[arr.length - 1] ?? 0;
  return arr[frame];
}

export function getSigma70PresenceArray(
  manifest: SimulationManifest,
): Float32Array {
  let arr = presenceCache.get(manifest);
  if (!arr) {
    arr = computeSigma70PresenceArray(manifest);
    presenceCache.set(manifest, arr);
  }
  return arr;
}
