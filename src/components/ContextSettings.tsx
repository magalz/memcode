import { useEffect, useState } from "react";
import { Check, Download, Network, RefreshCw } from "lucide-react";
import {
  contextAssistantDefaults,
  type ContextAssistantSettings,
  type ContextAssistantSetupState,
} from "../context-settings";
import { Select } from "./Select";
import { Spinner } from "./UI";
import "../styles-local-model.css";

const megabytes = (bytes: number) =>
  `${Math.ceil(bytes / 1_000_000).toLocaleString()} MB`;

export function ContextSettings({
  value,
  change,
}: {
  value?: ContextAssistantSettings;
  change: (value: ContextAssistantSettings) => void;
}) {
  const settings = value ?? contextAssistantDefaults;
  const update = (patch: Partial<ContextAssistantSettings>) =>
    change({ ...settings, ...patch });
  const [status, setStatus] = useState<ContextAssistantSetupState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const managed =
    settings.provider === "onnx" && !settings.packageDirectory.trim();
  const refresh = async () => {
    try {
      setStatus(await window.memcode.retrievalStatus());
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  };
  useEffect(() => {
    if (settings.enabled && managed) void refresh();
  }, [settings.enabled, managed]);
  useEffect(() => {
    if (!busy && status?.status !== "installing") return;
    const timer = setInterval(() => void refresh(), 750);
    return () => clearInterval(timer);
  }, [busy, status?.status]);
  const install = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await window.memcode.installRetrieval());
    } catch (error) {
      setError((error as Error).message);
      try {
        setStatus(await window.memcode.retrievalStatus());
      } catch {
        /* Keep the setup error visible. */
      }
    } finally {
      setBusy(false);
    }
  };
  const installing = busy || status?.status === "installing";
  const ready = status?.status === "ready";
  return (
    <section
      className="settings-section context-settings"
      aria-label="Local retrieval settings"
    >
      <div>
        <Network size={17} />
        <span>
          <strong>Focused code context</strong>
          <small>
            Memtrace finds the code. A local assistant helps plan the search.
          </small>
        </span>
        <span className="settings-tag">On this computer</span>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>
          Use a local retrieval assistant
          <small>
            Source facts, impact and coordination stay with Memtrace.
          </small>
        </span>
      </label>
      {settings.enabled && managed && (
        <div className="local-model-card" aria-busy={installing}>
          <div className="local-model-status">
            {installing ? (
              <Spinner />
            ) : ready ? (
              <Check size={15} />
            ) : (
              <Network size={15} />
            )}
            <strong>
              {ready
                ? "Ready to assist"
                : installing
                  ? status?.phase === "verify"
                    ? "Checking your local model…"
                    : "Downloading your local model…"
                  : "Set up local retrieval"}
            </strong>
            {ready && <span className="local-model-ready">Installed</span>}
          </div>
          <p>
            {status?.message ??
              (error
                ? "Local setup could not be checked. Try again below."
                : "Checking the model on this computer…")}
          </p>
          {installing && (
            <div className="local-model-progress" role="status">
              <progress
                aria-label="Local retrieval model download"
                max={status?.totalBytes || 1}
                value={status?.downloadedBytes ?? 0}
              />
              {status?.totalBytes ? (
                <small>
                  {megabytes(status.downloadedBytes)} of{" "}
                  {megabytes(status.totalBytes)}
                </small>
              ) : null}
            </div>
          )}
          {!ready && status?.status !== "unsupported" && (
            <button
              type="button"
              className="button primary"
              disabled={installing || (!status && !error)}
              onClick={() => void (status ? install() : refresh())}
            >
              {installing ? (
                <Spinner />
              ) : error || status?.status === "error" ? (
                <RefreshCw size={13} />
              ) : (
                <Download size={13} />
              )}
              {installing
                ? "Setting up…"
                : !status && error
                  ? "Check setup again"
                  : status?.status === "error"
                    ? "Retry setup"
                    : "Set up local retrieval"}
            </button>
          )}
          <small>
            {ready
              ? "Runs locally when a worker needs context. Save settings to use it."
              : `Downloads ${status?.totalBytes ? `about ${megabytes(status.totalBytes)} of ` : "the "}model files once. No extra app or package paths. Your code stays on this computer.`}
          </small>
        </div>
      )}
      {settings.enabled && (error || status?.status === "error") && (
        <p className="local-model-error" role="alert">
          {error || status?.message}
        </p>
      )}
      {settings.enabled && !managed && (
        <p className="settings-hint">
          Using your advanced local configuration.
          <button
            type="button"
            className="text-button"
            onClick={() =>
              update({
                provider: "onnx",
                packageDirectory: "",
                model: contextAssistantDefaults.model,
              })
            }
          >
            Use MemCode setup
          </button>
        </p>
      )}
      {settings.enabled && (
        <details className="local-model-advanced">
          <summary>Advanced · use an existing local model or server</summary>
          <label className="field">
            <span>Local inference</span>
            <Select
              aria-label="Context assistant provider"
              value={settings.provider}
              onValueChange={(value) =>
                update({
                  provider: value as ContextAssistantSettings["provider"],
                  ...(value === "onnx"
                    ? { model: contextAssistantDefaults.model }
                    : {}),
                })
              }
            >
              <option value="onnx">MemCode local model</option>
              <option value="openai-compatible">
                Existing local model server
              </option>
            </Select>
          </label>
          {settings.provider === "onnx" ? (
            <label className="field">
              <span>Optional Transformers package directory</span>
              <input
                aria-label="Context model package directory"
                placeholder="Leave blank to use MemCode’s managed setup"
                value={settings.packageDirectory}
                onChange={(event) =>
                  update({ packageDirectory: event.target.value })
                }
              />
            </label>
          ) : (
            <label className="field">
              <span>Local server API base</span>
              <input
                aria-label="Context model endpoint"
                placeholder="http://127.0.0.1:11434/v1"
                value={settings.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </label>
          )}
          <label className="field">
            <span>Local model</span>
            <input
              aria-label="Context assistant model"
              readOnly={settings.provider === "onnx"}
              value={settings.model}
              onChange={(event) => update({ model: event.target.value })}
            />
          </label>
        </details>
      )}
      <p className="settings-hint">
        Memtrace retrieval works without this optional model. Setup and local
        processing stay separate from your coding-model account.
      </p>
    </section>
  );
}
