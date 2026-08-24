import { useEffect, useState } from "react";
import {
  applyKernelSettings,
  currentApiOrigin,
  fetchKernelSettings,
} from "./api";
import type { KernelMode } from "./types";

export function SettingsPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<KernelMode>("local");
  const [customOrigin, setCustomOrigin] = useState("http://127.0.0.1:4370");
  const [activeOrigin, setActiveOrigin] = useState(currentApiOrigin());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchKernelSettings()
      .then((settings) => {
        setMode(settings.mode);
        setCustomOrigin(settings.customOrigin);
        setActiveOrigin(settings.activeOrigin);
      })
      .catch(() => {
        setError("Cannot read desktop settings");
      });
  }, []);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const settings = await applyKernelSettings({
        mode,
        origin: mode === "custom" ? customOrigin : undefined,
      });
      setMode(settings.mode);
      setCustomOrigin(settings.customOrigin);
      setActiveOrigin(settings.activeOrigin);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply kernel address");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">
        The console talks to a personal kernel over HTTP. Default is the local sidecar on this computer.
      </p>
      <section className="card">
        <h2>Kernel address</h2>
        <div className="kv">
          <span>In use</span>
          <strong>
            <code>{activeOrigin}</code>
          </strong>
        </div>
        <div className="choice-list">
          <button
            type="button"
            className={`choice${mode === "local" ? " active" : ""}`}
            onClick={() => setMode("local")}
          >
            <span className="choice-mark" />
            <span>
              <strong>Local</strong>
              <span className="muted">
                Start or reuse the sidecar on this computer (127.0.0.1, default port 4370).
              </span>
            </span>
          </button>
          <button
            type="button"
            className={`choice${mode === "custom" ? " active" : ""}`}
            onClick={() => setMode("custom")}
          >
            <span className="choice-mark" />
            <span>
              <strong>Custom</strong>
              <span className="muted">
                Point at another personal kernel. Apply probes /health first; a remote
                server needs REGENIC_PERSONAL_API=1.
              </span>
            </span>
          </button>
        </div>
        {mode === "custom" ? (
          <label className="field">
            <span>URL</span>
            <input
              value={customOrigin}
              placeholder="http://127.0.0.1:4370"
              onChange={(event) => setCustomOrigin(event.target.value)}
            />
          </label>
        ) : null}
        {mode === "custom" && activeOrigin !== customOrigin ? (
          <p className="muted">
            Saved custom kernel is unused. Console is on <code>{activeOrigin}</code>{" "}
            until Apply succeeds.
          </p>
        ) : null}
        <div className="install-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
        {error ? <p className="action-error">{error}</p> : null}
      </section>
    </div>
  );
}
