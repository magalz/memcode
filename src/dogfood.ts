import type { AppState, Epic, Project, Stage, WorkItem } from "./shared";

interface StorySpec {
  key: string;
  title: string;
  description: string;
  scope: string[];
  stage?: Stage;
  kind?: WorkItem["kind"];
  after?: string[];
}
interface EpicSpec {
  key: string;
  title: string;
  description: string;
  phase: Epic["phase"];
  color: Epic["color"];
  stories: StorySpec[];
}

export const dogfoodPlan: EpicSpec[] = [
  {
    key: "foundation",
    title: "A workspace worth spending time in",
    description:
      "An independent desktop suite with a clear, polished path from project brief to reviewed work.",
    phase: "now",
    color: "mint",
    stories: [
      {
        key: "desktop",
        title: "Build the independent Electron foundation",
        description:
          "Keep MemCode in its own repository. Ship a React renderer, a narrow preload, validated IPC and local workspace persistence.",
        scope: ["electron/main.ts", "electron/preload.ts"],
        stage: "done",
      },
      {
        key: "projects",
        title: "Start from a project folder or a fresh idea",
        description:
          "Create or open local projects. Preserve the project purpose and initialize a fresh Git repository without touching existing user work.",
        scope: ["electron/main.ts", "src/components/Dialogs.tsx"],
        stage: "done",
      },
      {
        key: "work-items",
        title: "Keep the brief, runbook and conversation together",
        description:
          "Use one work-item model across board, list and focused detail. Save notes and runbook progress locally.",
        scope: ["src/components/Board.tsx", "src/components/WorkDetail.tsx"],
        stage: "done",
      },
      {
        key: "selectors",
        title: "Give every selector the Memtrace finish",
        description:
          "Replace native dropdown chrome with styled, accessible menus. Check keyboard navigation, focus, overflow, and the browser overlay interaction.",
        scope: ["src/components/Select.tsx", "src/styles-select.css"],
        stage: "done",
      },
    ],
  },
  {
    key: "intelligence",
    title: "Understand the code before changing it",
    description:
      "Memtrace supplies source anchors, measured structure and explicit uncertainty.",
    phase: "now",
    color: "cyan",
    stories: [
      {
        key: "engine",
        title: "Connect the installed Memtrace engine",
        description:
          "Use MCP to index only the selected repository. Keep the engine independent, and report indexing failures rather than silently inventing context.",
        scope: ["electron/memtrace.ts"],
        stage: "done",
      },
      {
        key: "measurements",
        title: "Carry measured complexity and provenance into the work",
        description:
          "Collect AST cognitive/cyclomatic complexity, nesting, primary-anchor impact, process exposure and source/graph revisions. Missing data stays unknown.",
        scope: ["electron/qualification.ts"],
        stage: "done",
      },
      {
        key: "freshness",
        title: "Keep project context fresh as workers edit",
        description:
          "Add a documented watcher lifecycle, refresh only relevant scopes, and surface stale source/index bindings in the work item.",
        scope: ["electron/memtrace.ts", "electron/qualification.ts"],
        after: ["engine"],
      },
      {
        key: "bundles",
        title: "Build a focused context bundle for each story",
        description:
          "Include definitions, relevant callers, recorded decisions, style examples and verification targets with bounded source reads.",
        scope: ["electron/qualification.ts", "electron/workers.ts"],
        after: ["measurements"],
      },
      {
        key: "actual-diff",
        title: "Qualify the actual change after implementation",
        description:
          "Reindex the shared epic branch and compare actual touched symbols with the declared scope. Preserve unknown reachability and flag scope growth.",
        scope: ["electron/workers.ts", "electron/qualification.ts"],
        after: ["measurements"],
      },
    ],
  },
  {
    key: "orchestration",
    title: "The right model for the measured work",
    description:
      "A transparent capability envelope chooses a concrete model, effort and eligible local harness.",
    phase: "now",
    color: "lavender",
    stories: [
      {
        key: "catalog",
        title: "Discover Claude Code, Cursor Agent and Codex models",
        description:
          "Reuse the previous orchestrator’s runtime detection. Read the Codex model cache, query Cursor’s CLI catalog, and support documented Claude aliases.",
        scope: ["electron/commands.ts", "electron/catalog.ts"],
        stage: "done",
      },
      {
        key: "routing",
        title: "Route with measured capability envelopes",
        description:
          "Apply the existing four-tier envelope concept to measured AST and impact inputs. Persist the chosen harness, model, effort and reasons. Label the policy provisional.",
        scope: ["electron/router.ts"],
        stage: "done",
        after: ["measurements", "catalog"],
      },
      {
        key: "route-ui",
        title: "Explain the route in the work item",
        description:
          "Show the actual model, capability tier, measured inputs, missing evidence and override behavior. Re-plan before launching a worker.",
        scope: ["src/components/WorkDetail.tsx"],
        stage: "done",
        after: ["routing"],
      },
      {
        key: "route-regressions",
        title: "Add regression coverage for routing fallbacks",
        description:
          "Dogfood story: add focused tests for unavailable preferred harnesses, explicit model overrides, incomplete evidence and model capability boundaries. Work only in tests/routing-regressions.test.ts. Do not change production code. Run the test suite and report what ran.",
        scope: ["electron/router.ts", "tests/routing.test.ts"],
        kind: "test",
        after: ["routing"],
      },
      {
        key: "escalation",
        title: "Escalate for the observed failure, not every failure",
        description:
          "Separate auth/environment failures, failed checks, scope growth and reasoning difficulty. Add bounded repair and model escalation with an attempt history.",
        scope: ["electron/workers.ts", "electron/router.ts"],
        after: ["routing", "actual-diff"],
      },
    ],
  },
  {
    key: "workers",
    title: "Local harnesses that do real work",
    description:
      "Keep story workers observable and stoppable while they share a coordinated epic branch.",
    phase: "now",
    color: "mint",
    stories: [
      {
        key: "worktrees",
        title: "Run story workers on a shared epic branch",
        description:
          "Map an epic to one Git branch. Run multiple story workers in the shared project folder, with Fleet intent, renewable reservations and human conflict resolution. Preserve shared changes and separate worker outputs.",
        scope: ["electron/workers.ts"],
        stage: "done",
      },
      {
        key: "harness-conformance",
        title: "Conformance-test each installed coding harness",
        description:
          "Run a small, bounded real task through Codex, Claude Code and Cursor Agent. Verify model arguments, tool authority, output parsing, artifact paths and failure states.",
        scope: ["electron/workers.ts", "electron/commands.ts"],
        after: ["catalog", "worktrees"],
      },
      {
        key: "cancellation",
        title: "Prove cancellation cleans up the process tree",
        description:
          "Exercise cancellation during tools and nested subprocesses. Preserve partial patches and distinguish a stop request from confirmed termination.",
        scope: ["electron/workers.ts", "tests/core.test.ts"],
        after: ["worktrees"],
      },
      {
        key: "resume",
        title: "Resume work with the right conversation and checkout",
        description:
          "Bind native session IDs, checkpoints, prompt context and the shared epic branch. Never resume the wrong global “last session.”",
        scope: ["electron/workers.ts", "src/shared.ts"],
        after: ["worktrees"],
      },
      {
        key: "budgets",
        title: "Bound worker time, spending and child activity",
        description:
          "Track the parent envelope, descendant work and provider accounting limits. Stop or checkpoint explicitly rather than retrying forever.",
        scope: ["electron/workers.ts", "src/shared.ts"],
        after: ["harness-conformance"],
      },
    ],
  },
  {
    key: "fleet",
    title: "A fleet that moves together",
    description:
      "Turn cooperative coordination into a dependable execution and integration protocol.",
    phase: "next",
    color: "cyan",
    stories: [
      {
        key: "fleet-intents",
        title: "Publish scope and keep Fleet intent alive",
        description:
          "Use the actual epic branch for all Fleet calls, preflight declared scope, acquire and renew reservations, publish intent, record episodes and pause for unresolved conflicts.",
        scope: ["electron/memtrace.ts", "electron/workers.ts"],
        stage: "done",
      },
      {
        key: "leases",
        title: "Acquire and renew exclusive work reservations",
        description:
          "Reserve declared symbols/resources in a stable order. Handle expiry, preemption and scope expansion explicitly.",
        scope: ["electron/memtrace.ts", "electron/workers.ts"],
        after: ["actual-diff", "fleet-intents"],
      },
      {
        key: "fencing",
        title: "Reject stale workers at the acceptance boundary",
        description:
          "Add attempt epochs and an authoritative integration gate. A paused or expired worker must not publish after another owner takes over.",
        scope: ["electron/workers.ts", "electron/main.ts"],
        after: ["leases"],
      },
      {
        key: "integration",
        title: "Reconcile and integrate dependent worker changes",
        description:
          "Handle A/B/C episodes against actual diffs, refresh stale reads, serialize integration where needed, and require explicit resolution of destructive conflicts.",
        scope: ["electron/memtrace.ts", "electron/workers.ts"],
        after: ["fencing", "host-checks"],
      },
    ],
  },
  {
    key: "outputs",
    title: "See what the fleet produces",
    description:
      "Keep browser, artifacts and voice close to the work rather than opening a maze of tools.",
    phase: "next",
    color: "amber",
    stories: [
      {
        key: "previews",
        title: "Preview local apps and artifacts in an isolated browser",
        description:
          "Use a separate WebContentsView without the desktop preload. Support local development addresses, HTML/image previews and screenshots.",
        scope: ["electron/preview.ts", "src/components/WorkDetail.tsx"],
        stage: "done",
      },
      {
        key: "artifact-normalization",
        title: "Normalize outputs across worker harnesses",
        description:
          "Collect each harness’s report, image, file and preview references with producing attempt, source revision and content identity.",
        scope: ["electron/workers.ts", "src/shared.ts"],
        after: ["harness-conformance"],
      },
      {
        key: "voice",
        title: "Make local dictation easy to set up",
        description:
          "Build on the existing microphone-to-WAV-to-Whisper flow. Add server health, model installation guidance, recording recovery and real transcription checks.",
        scope: ["src/useDictation.ts", "src/components/Dialogs.tsx"],
        after: ["projects"],
      },
      {
        key: "preview-lifecycle",
        title: "Polish browser lifecycle and overlay behavior",
        description:
          "Test resize, hidden tabs, popovers, failures, reload, local server restarts and capture ownership. Preserve a clear recovery path.",
        scope: ["electron/preview.ts", "src/components/WorkDetail.tsx"],
        after: ["previews"],
      },
    ],
  },
  {
    key: "verification",
    title: "A result you can review with confidence",
    description:
      "Make actual checks and their limits part of every accepted change.",
    phase: "next",
    color: "lavender",
    stories: [
      {
        key: "host-checks",
        title: "Run acceptance checks on an explicit epic revision",
        description:
          "Execute repository-appropriate structured checks on the candidate revision. Separate baseline failures from introduced failures and preserve command evidence.",
        scope: ["electron/workers.ts", "electron/main.ts"],
        after: ["worktrees"],
      },
      {
        key: "receipt",
        title: "Return a change receipt bound to the tested revision",
        description:
          "Bind the patch, source graph, route, environment, checks, skipped checks and unresolved risks to a durable review object.",
        scope: ["src/shared.ts", "src/components/WorkDetail.tsx"],
        after: ["host-checks", "actual-diff"],
      },
      {
        key: "review",
        title: "Add independent review and contract validation",
        description:
          "Combine deterministic Memtrace findings with appropriate tests and review. Escalate consequential unknowns without treating an LLM review as proof.",
        scope: ["electron/qualification.ts", "electron/workers.ts"],
        after: ["receipt"],
      },
      {
        key: "routing-evaluation",
        title: "Measure routing benefit against a strong baseline",
        description:
          "Compare graph context and measured routing on frozen real tasks. Track accepted-change cost, reviewer time and regressions without invented confidence.",
        scope: ["electron/router.ts", "tests/routing.test.ts"],
        after: ["route-regressions", "receipt"],
      },
    ],
  },
  {
    key: "dogfood",
    title: "Build MemCode with MemCode",
    description:
      "Use the suite’s own source graph, stories and worker results to improve the product continuously.",
    phase: "now",
    color: "mint",
    stories: [
      {
        key: "split-app",
        title: "Extract the heaviest workspace views from App",
        description:
          "Memtrace measured App at cyclomatic 105, cognitive 142 and nesting 4 in the first foundation snapshot. Extract coherent view components without changing user behavior, then remeasure and run UI checks.",
        scope: ["src/App.tsx"],
        kind: "refactor",
        after: ["route-regressions"],
      },
      {
        key: "split-runtime",
        title: "Separate desktop composition from task controllers",
        description:
          "Reduce the main start function by extracting project and task lifecycle services with explicit contracts. Preserve IPC validation and current local behavior.",
        scope: ["electron/main.ts"],
        kind: "refactor",
        after: ["route-regressions"],
      },
      {
        key: "feedback",
        title: "Capture what each dogfood iteration teaches us",
        description:
          "Record accepted results, rejected approaches, route failures and UX findings with provenance. Feed stable decisions into Memtrace rather than retaining task state as permanent knowledge.",
        scope: ["src/shared.ts", "electron/memtrace.ts"],
        after: ["receipt"],
      },
    ],
  },
  {
    key: "release",
    title: "Make it a product developers can adopt",
    description:
      "Package a reliable local suite and prepare a deliberate open-source release.",
    phase: "later",
    color: "cyan",
    stories: [
      {
        key: "packaging",
        title: "Package installable desktop builds",
        description:
          "Add reproducible Windows and macOS packaging, versioned migrations, signing/release decisions and a reliable update path.",
        scope: ["package.json", "scripts/build.mjs"],
        after: ["preview-lifecycle", "cancellation"],
      },
      {
        key: "accessibility",
        title: "Audit the full desktop experience for accessibility",
        description:
          "Check keyboard-only navigation, focus restoration, screen-reader labels, color contrast, zoom and reduced motion across every product flow.",
        scope: ["src/components/Select.tsx", "src/styles.css"],
        after: ["selectors"],
      },
      {
        key: "privacy",
        title: "Make model and data processing choices explicit",
        description:
          "Show where source context, inference, speech, logs and artifacts are processed. Add opt-in diagnostics with local retention controls.",
        scope: ["src/components/Dialogs.tsx", "electron/main.ts"],
        after: ["budgets"],
      },
      {
        key: "open-source",
        title: "Prepare the repository for open-source contributors",
        description:
          "Choose the app license and dependency policy, document the Memtrace boundary, add contribution/CI guidance, and publish only after the release decision.",
        scope: ["README.md", "AGENTS.md"],
        after: ["packaging"],
      },
    ],
  },
];

export function installDogfoodPlan(
  state: AppState,
  project: Project,
): { epics: number; stories: number } {
  let epics = 0,
    stories = 0;
  const time = new Date().toISOString();
  const ids = new Map<string, string>();
  const created = new Set<string>();
  let sequence = state.tasks
    .filter((t) => t.projectId === project.id)
    .reduce(
      (max, t) => Math.max(max, Number(t.identifier.split("-").at(-1)) || 0),
      0,
    );
  for (const [index, spec] of dogfoodPlan.entries()) {
    let epic = state.epics.find(
      (e) => e.projectId === project.id && e.sourceKey === spec.key,
    );
    if (!epic) {
      epic = {
        id: project.id + "-epic-" + spec.key,
        projectId: project.id,
        identifier: `EP-${String(index + 1).padStart(2, "0")}`,
        title: spec.title,
        description: spec.description,
        phase: spec.phase,
        color: spec.color,
        order: index,
        sourceKey: spec.key,
      };
      state.epics.push(epic);
      epics++;
    }
    for (const story of spec.stories) {
      const existing = state.tasks.find(
        (t) => t.projectId === project.id && t.sourceKey === story.key,
      );
      if (existing) {
        ids.set(story.key, existing.id);
        continue;
      }
      const id = project.id + "-story-" + story.key;
      created.add(id);
      ids.set(story.key, id);
      state.tasks.push({
        id,
        identifier: `MC-${String(++sequence).padStart(3, "0")}`,
        projectId: project.id,
        title: story.title,
        description: story.description,
        stage: story.stage ?? "planned",
        priority: spec.phase === "now" ? "high" : "medium",
        category:
          story.kind === "test"
            ? "Verification"
            : spec.key === "foundation"
              ? "Experience"
              : spec.key === "orchestration"
                ? "Orchestration"
                : spec.key === "intelligence"
                  ? "Intelligence"
                  : "Engineering",
        harness: "codex",
        assignment: "auto",
        epicId: epic.id,
        scope: story.scope,
        kind: story.kind ?? "feature",
        sourceKey: story.key,
        dependsOn: [],
        checklist: [
          {
            id: id + ":scope",
            text: "Read the relevant source and qualify the scope",
            done: story.stage === "done",
          },
          {
            id: id + ":build",
            text: "Implement a focused, reviewable iteration",
            done: story.stage === "done",
          },
          {
            id: id + ":verify",
            text: "Run appropriate checks and review the actual result",
            done: story.stage === "done",
          },
        ],
        messages: [
          {
            id: id + ":brief",
            role: "user",
            text: story.description,
            at: time,
          },
        ],
        run: { state: "idle" },
        ...(project.example ? { example: true } : {}),
        createdAt: time,
        updatedAt: time,
      });
      stories++;
    }
  }
  for (const spec of dogfoodPlan)
    for (const story of spec.stories) {
      const task = state.tasks.find((t) => t.id === ids.get(story.key));
      if (task && created.has(task.id))
        task.dependsOn = (story.after ?? [])
          .map((key) => ids.get(key))
          .filter((id): id is string => !!id);
    }
  return { epics, stories };
}
