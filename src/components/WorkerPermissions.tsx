import type { WorkItem, TaskPatch } from "../shared";
import { harnessNames } from "../shared";
import { isActive } from "../domain";
import {
  permissionModes,
  permissionLabels,
  permissionDescription,
  supportsPermissionMode,
  type PermissionMode,
} from "../permissions";
import { Select } from "./Select";
import "../styles-worker-permissions.css";

export function WorkerPermissions({
  task,
  update,
}: {
  task: WorkItem;
  update(patch: TaskPatch): void;
}) {
  const mode = task.permissionMode ?? "review";
  const active = isActive(task);
  const current = task.run.permissionMode ?? "review";
  return (
    <div className="worker-permissions">
      <label className="inspector-field">
        <span>Permissions</span>
        <Select
          aria-label="Worker permission mode"
          value={mode}
          onValueChange={(value) =>
            update({ permissionMode: value as PermissionMode })
          }
        >
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
      <p>
        {mode === "auto" && task.assignment === "auto"
          ? "Uses the native reviewer in Codex or Claude Code. Automatic routing selects a connected worker that supports this mode."
          : permissionDescription(task.harness, mode)}
      </p>
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
