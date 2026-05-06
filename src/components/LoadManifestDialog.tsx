import { useEffect, useRef, useState } from "react";
import { parseManifest, type SimulationManifest } from "../types/manifest";

interface LoadManifestDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the parsed manifest and the source string (filename or URL). */
  onLoaded: (manifest: SimulationManifest, source: string) => void;
}

/**
 * Modal dialog that lets the user replace the currently-loaded simulation
 * manifest with one fetched from a URL or dragged/picked off their disk.
 *
 * Validation happens in two stages:
 *   1. The raw text must parse as JSON whose top-level object looks like
 *      an rnasim manifest — i.e. it either carries the `"application":
 *      "RNASim"` provenance marker, or (for back-compat with older
 *      snapshots.json files) has the full set of expected top-level
 *      keys.  We reject loudly if `application` is present with a
 *      different value, since that's a strong signal the user picked the
 *      wrong file.
 *   2. The parsed object is run through the full zod schema via
 *      `parseManifest`.  Schema failures surface their first issue to
 *      the user rather than dumping the whole ZodError.
 */
export function LoadManifestDialog({
  open,
  onClose,
  onLoaded,
}: LoadManifestDialogProps) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Clear transient state on open so a second visit starts clean.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    // Focus the URL field so keyboard users can start typing immediately.
    const t = setTimeout(() => urlInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // ----------------------------------------------------------- validation
  // Sanity-check the top-level shape BEFORE handing to zod so we can emit
  // a friendly "this doesn't look like an RNASim file" error up front.
  const preCheck = (raw: unknown): string | null => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "Top-level JSON value is not an object.";
    }
    const obj = raw as Record<string, unknown>;
    if ("application" in obj && obj.application !== "RNASim") {
      return `This file identifies itself as application "${obj.application}", not "RNASim".`;
    }
    // If there's no application marker (older file), require the full
    // set of top-level keys as a surrogate provenance check.
    if (!("application" in obj)) {
      const need = ["version", "metadata", "sequence", "promoter", "params", "snapshots"];
      const missing = need.filter((k) => !(k in obj));
      if (missing.length > 0) {
        return (
          `This doesn't look like an RNASim manifest ` +
          `(missing: ${missing.join(", ")}).`
        );
      }
    }
    return null;
  };

  const finishLoad = (manifest: SimulationManifest, source: string) => {
    // Close the dialog first so it is fully unmounted before the
    // manifest-swap cascade fires (setViewerKey tears down Viewer3D,
    // which on Safari can throw when pointer-capture / WebGL teardown
    // races with an in-progress async handler inside the still-mounted
    // dialog).  We defer onLoaded by one animation frame so the React
    // tree has flushed the close before the remount begins.
    onClose();
    requestAnimationFrame(() => {
      try {
        onLoaded(manifest, source);
      } catch (e) {
        // Dialog is already closed; log rather than trying to setState
        // on the unmounted component.
        console.error(
          "rnasim: failed to apply loaded manifest —",
          e instanceof Error ? e.message : String(e),
        );
      }
    });
  };

  /** True when the response body smells like HTML rather than JSON, e.g.
   *  the Vite dev server returning the SPA shell for an unmatched path,
   *  or a 404 page from a static host. Without this check JSON.parse
   *  blows up with the unhelpful "Unrecognized token '<'". */
  const looksLikeHtml = (text: string, contentType: string | null): boolean => {
    if (contentType && /text\/html|application\/xhtml/i.test(contentType)) {
      return true;
    }
    // First non-whitespace chars are an HTML opener.
    return /^\s*<(?:!doctype|html|head|body|script|meta)\b/i.test(text);
  };

  const loadFromText = (
    text: string,
    source: string,
    contentType: string | null = null,
  ) => {
    if (looksLikeHtml(text, contentType)) {
      setError(
        `${source}: server returned HTML, not JSON — the URL probably ` +
          `doesn't exist (a dev-server SPA fallback or a 404 page was ` +
          `served instead).`,
      );
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      setError(
        `${source}: could not parse as JSON — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return;
    }
    const shapeErr = preCheck(raw);
    if (shapeErr) {
      setError(`${source}: ${shapeErr}`);
      return;
    }
    try {
      const manifest = parseManifest(raw);
      finishLoad(manifest, source);
    } catch (e) {
      // zod errors can be verbose — surface just the first issue's path+message.
      const msg = (() => {
        if (
          e &&
          typeof e === "object" &&
          "issues" in e &&
          Array.isArray((e as { issues?: unknown[] }).issues) &&
          (e as { issues: unknown[] }).issues.length > 0
        ) {
          const first = (e as { issues: Array<{ path: unknown[]; message: string }> })
            .issues[0];
          const path = first.path.length > 0 ? first.path.join(".") + ": " : "";
          return `${path}${first.message}`;
        }
        return e instanceof Error ? e.message : String(e);
      })();
      setError(`${source}: schema mismatch — ${msg}`);
    }
  };

  const loadFromFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError(`"${file.name}" is not a .json file.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      // Files don't carry a Content-Type the way HTTP responses do;
      // looksLikeHtml's body sniff still catches HTML disguised as .json.
      loadFromText(text, file.name, null);
    } catch (e) {
      setError(
        `Reading "${file.name}" failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  const loadFromUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    // Validate URL syntax before fetch.  We accept either a full absolute
    // URL or a path relative to the current origin.  Going through `new
    // URL` here catches typos and stops Safari from throwing an opaque
    // TypeError ("Type error" with no message) inside fetch on malformed
    // input — that error used to bubble through React and blank the page
    // because it surfaced after a microtask boundary.
    let resolved: string;
    try {
      resolved = new URL(trimmed, window.location.href).toString();
    } catch {
      setError(`"${trimmed}" is not a valid URL.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(resolved);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const contentType = res.headers.get("content-type");
      const text = await res.text();
      loadFromText(text, trimmed, contentType);
    } catch (e) {
      setError(
        `Fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------- drop handlers
  // Typed to HTMLElement so the same handlers work whether the dropzone
  // is rendered as a <div> (old version) or a <label> (current version,
  // chosen so the OS file picker opens via native label→input forwarding).
  const onDropZoneDragOver = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDropZoneDragLeave = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };
  const onDropZoneDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFromFile(file);
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFromFile(file);
    // Allow re-selecting the same file next time.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(_e) => {
        // Close when the user clicks the bare backdrop (outside the dialog).
        // The dialog itself stops mousedown propagation (below), so this
        // handler only fires for genuine outside clicks.
        onClose();
      }}
    >
      <div
        className="modal-dialog load-manifest-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-manifest-title"
        ref={dialogRef}
        onMouseDown={(e) => {
          // Stop mousedown from reaching the backdrop so clicks on the file
          // input (whose ::file-selector-button lives in shadow DOM) can
          // never accidentally satisfy the backdrop's close condition.
          // stopPropagation does NOT call preventDefault, so the file
          // picker still opens normally.
          e.stopPropagation();
        }}
      >
        <header className="modal-header">
          <h3 id="load-manifest-title">Load Simulation File</h3>
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

        <div className="modal-body">
          <section className="load-source">
            <label htmlFor="load-manifest-url">
              <strong>URL</strong>
              <span className="muted"> — fetch a snapshots.json hosted on the web</span>
            </label>
            <div className="load-url-row">
              <input
                ref={urlInputRef}
                id="load-manifest-url"
                // `type="text"` (not `type="url"`) on purpose — Safari's
                // built-in URL validation was rejecting paste-target
                // shapes like `/snapshots.json` and bare `localhost:5173/…`,
                // and on submit could throw a TypeError out of the input
                // before our `new URL()` parser saw the value.  We do our
                // own URL validation in loadFromUrl() instead.
                type="text"
                value={url}
                placeholder="https://example.com/snapshots.json"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void loadFromUrl();
                  }
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => void loadFromUrl()}
                disabled={busy || url.trim().length === 0}
              >
                Fetch
              </button>
            </div>
          </section>

          <div className="load-or">or</div>

          {/* The drop zone is a plain <div> (not <label>) so Safari does not
              also trigger the file picker when a file is dragged-and-dropped
              onto it.  The "click to browse" affordance uses the label-
              wrapping pattern: a <label> with the file input as a direct
              child.  Chrome and Safari both honour native label→child-input
              forwarding unconditionally (no programmatic .click() involved,
              no display:none visibility restriction, no security-model edge
              cases). */}
          <div
            className={"load-dropzone" + (dragActive ? " active" : "")}
            onDragOver={onDropZoneDragOver}
            onDragEnter={onDropZoneDragOver}
            onDragLeave={onDropZoneDragLeave}
            onDrop={onDropZoneDrop}
            aria-label="Drop zone for snapshots.json"
          >
            <p className="load-dropzone-main">
              Drop a <code>snapshots.json</code> here
            </p>
            <p className="load-dropzone-sub">
              or{" "}
              {/* Every approach to hiding the file input (display:none,
                  visibility:hidden, clip-rect, opacity:0 overlay) has
                  been blocked by Chrome.  The only thing Chrome cannot
                  block is a direct user-click on the native input element
                  itself.  We render the input fully visible but use
                  ::file-selector-button + font-size:0 to make it look
                  exactly like "click to browse" link text — no JS
                  indirection, no hidden elements. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={onFilePicked}
                disabled={busy}
                className="load-browse-input"
              />
            </p>
          </div>

          {busy && <div className="load-busy">Loading…</div>}
          {error && <div className="load-error">{error}</div>}

          <footer className="load-footer">
            <p>
              Files are validated locally — nothing is uploaded. The loader
              accepts JSON emitted by <code>python -m rnasim</code>
              (manifest version&nbsp;1.0, tagged
              {" "}<code>"application": "RNASim"</code>).
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
