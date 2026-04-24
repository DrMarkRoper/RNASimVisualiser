import { useEffect, useState } from "react";
import {
  parseManifest,
  type SimulationManifest,
} from "../types/manifest";

export type ManifestState =
  | { status: "loading" }
  | { status: "ready"; manifest: SimulationManifest }
  | { status: "error"; error: string };

/**
 * Fetches the simulation manifest from a static URL and validates it
 * against the SimulationManifest zod schema.
 *
 * Default URL = /snapshots.json (served from Vite's `public/` directory
 * during dev, and from the built site at runtime).
 */
export function useManifest(url: string = "/snapshots.json"): ManifestState {
  const [state, setState] = useState<ManifestState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

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
  }, [url]);

  return state;
}
