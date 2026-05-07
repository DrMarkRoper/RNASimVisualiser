import { useCallback, useEffect, useState } from "react";
import {
  parseManifest,
  type SimulationManifest,
} from "../types/manifest";

export type ManifestState =
  | { status: "loading" }
  | { status: "ready"; manifest: SimulationManifest }
  | { status: "error"; error: string };

export interface ManifestController {
  /** Replace the current manifest with a pre-validated one (e.g. from the
   *  Load Simulation File dialog after it has already parsed the JSON). */
  setManifest: (manifest: SimulationManifest) => void;
  /** Re-fetch from the initial URL.  Not currently exposed in the UI but
   *  handy for future "reload default simulation" affordances. */
  reload: () => void;
}

/**
 * Fetches the simulation manifest from a static URL, validates it against
 * the SimulationManifest zod schema, and exposes an imperative setter so
 * the Load Simulation File dialog can swap the manifest in-place without
 * the page being reloaded.
 *
 * Default URL = /snapshots.json (served from Vite's `public/` directory
 * during dev, and from the built site at runtime).
 */
export function useManifest(
  url: string = `${import.meta.env.BASE_URL}snapshots.json`,
): [ManifestState, ManifestController] {
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        }
        const raw = await res.json();
        const manifest = parseManifest(raw);
        if (!cancelled) setState({ status: "ready", manifest });
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  const setManifest = useCallback((manifest: SimulationManifest) => {
    setState({ status: "ready", manifest });
  }, []);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return [state, { setManifest, reload }];
}
