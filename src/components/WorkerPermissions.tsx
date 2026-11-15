import type { WorkItem, TaskPatch, Settings } from "../shared";
import { harnessNames } from "../shared";
import { isActive } from "../domain";
import {
  permissionModes,
  permissionLabels,
  permissionDescription,
  supportsPermissionMode,
  effectivePermissionMode,
  type PermissionMode,
} from "../permissions";
import { Select } from "./Select";
import "../styles-worker-permissions.css";

export function WorkerPermissions({
  task,
  settings,
  onDefaults,
  update,
}: {
  task: WorkItem;
  settings: Settings;
  onDefaults(): void;
  update(patch: TaskPatch): void;
}) {
  const inherited = task.permissionMode == null;
  const mode = effectivePermissionMode(task, settings);
  const active = isActive(task);
  const current = task.run.permissionMode ?? "review";
  return (
    <div className="worker-permissions">
      <label className="inspector-field">
        <span>Permissions</span>
        <Select
          aria-label="Worker permission mode"
          value={inherited ? "inherit" : mode}
          onValueChange={(value) =>
            update({
              permissionMode:
                value === "inherit" ? null : (value as PermissionMode),
            })
          }
        >
          <option value="inherit">Worker default</option>
          {permissionModes.map((value) => (
            <option
              key={value}
              value={value}
              disabled={
                task.assignment !== "auto" &&
                !supportsPermissionMode(task.harness, value)
              }
            >
              {permissionLabels[value]}
            </option>
          ))}
        </Select>
      </label>
      {inherited && (
        <p>
          {task.assignment === "auto"
            ? "Uses the default of the worker selected for this task."
            : `${harnessNames[task.harness]} default: ${permissionLabels[mode]}.`}
        </p>
      )}
      <p>
        {inherited && task.assignment === "auto"
          ? "Set each worker’s standard permissions once in Workers."
          : mode === "auto" && task.assignment === "auto"
            ? "Uses the native reviewer in Codex or Claude Code. Automatic routing selects a connected worker that supports this mode."
            : permissionDescription(task.harness, mode)}
      </p>
      <button
        type="button"
        className="worker-defaults-link"
        onClick={onDefaults}
      >
        Worker defaults <span aria-hidden="true">↗</span>
      </button>
      {active && (
        <small>
          {current !== mode ? `Running: ${permissionLabels[current]}. ` : ""}
          Changes apply to the next worker pass.
        </small>
      )}
      {mode === "auto" && supportsPermissionMode(task.harness, mode) && (
        <span className="worker-permission-native">
          {task.assignment === "auto"
            ? "Native approval review"
            : `${harnessNames[task.harness]} native reviewer`}
        </span>
      )}
      {task.harness === "cursor" &&
        task.assignment !== "auto" &&
        mode !== "auto" && (
          <span className="worker-permission-native">
            Smart Auto is unavailable through Cursor ACP.
          </span>
        )}
    </div>
  );
}
