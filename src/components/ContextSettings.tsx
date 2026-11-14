import { Network } from "lucide-react";
import {
  contextAssistantDefaults,
  type ContextAssistantSettings,
} from "../context-settings";
import { Select } from "./Select";

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
  return (
    <div className="settings-section">
      <div>
        <Network size={17} />
        <span>
          <strong>Focused code context</strong>
          <small>
            MemCode retrieves source evidence through a small worker gateway.
          </small>
        </span>
        <span className="settings-tag">Claude pilot</span>
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
            Helps plan searches. Source facts, constraints and coordination stay
            with Memtrace.
          </small>
        </span>
      </label>
      {settings.enabled && (
        <>
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
              <option value="onnx">
                Cached ONNX model · runs on this computer
              </option>
              <option value="openai-compatible">
                Local model server · loopback endpoint
              </option>
            </Select>
          </label>
          {settings.provider === "onnx" ? (
            <label className="field">
              <span>Transformers package directory</span>
              <input
                aria-label="Context model package directory"
                placeholder="Absolute path to @huggingface/transformers with its cached model"
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
        </>
      )}
      <p className="settings-hint">
        Deterministic retrieval works without a model. ONNX uses existing local
        files without downloading weights. Unavailable assistance falls back to
        deterministic retrieval. The pilot keeps normal project rules and
        authentication.
      </p>
    </div>
  );
}
