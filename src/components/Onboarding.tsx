import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  FolderPlus,
  Layers3,
  MessageSquare,
  Plug,
  Sparkles,
  X,
} from "lucide-react";
import type { AppState, Project, Epic } from "../shared";
import type {
  GuideAction,
  OnboardingPatch,
  OnboardingProgress,
} from "../onboarding";
import { Modal } from "./Dialogs";
import { GuideFlow } from "./GuideFlow";
import { BetaAccess } from "./BetaAccess";
import "../styles-onboarding.css";
const copy = {
  project: {
    number: 1,
    title: "Give your idea a home.",
    body: "Start a new project, or open a folder you already work in. MemCode keeps the work beside your code.",
    button: "Create or open a project",
    target: "[data-guide=project-picker]",
  },
  worker: {
    number: 2,
    title: "Connect a worker you trust.",
    body: "Choose Codex, Claude Code or Cursor. Review the connection and approve it. Nothing starts coding yet.",
    button: "Choose a worker",
    target: "[data-guide=worker-connections]",
  },
  epic: {
    number: 3,
    title: "Name the outcome.",
    body: "An epic groups a useful piece of work. Try “Launch the first version” or “Improve sign-in”. One clear outcome is enough.",
    button: "Write your first epic",
    target: "[data-guide=new-epic]",
  },
  story: {
    number: 4,
    title: "Make one small, clear request.",
    body: "A story is a task a worker can act on. Say what should change, who it helps, and what success looks like.",
    button: "Write your first story",
    target: "[data-guide=new-story]",
  },
  ready: {
    number: 4,
    title: "Your first story is ready.",
    body: "Open it, review the brief and suggested model, then start when you choose. Follow its conversation, changes and output in the same card.",
    button: "Open my story",
    target: ".work-inspector",
  },
};
export function Onboarding({
  progress,
  state,
  project,
  epics,
  connected,
  hidden,
  onUpdate,
  onAction,
  onDocs,
  needsEngine = false,
  notify,
}: {
  progress: OnboardingProgress;
  state: AppState;
  project: Project;
  epics: Epic[];
  connected: boolean;
  hidden: boolean;
  onUpdate: (patch: OnboardingPatch) => void;
  onAction: (action: GuideAction) => void;
  onDocs: () => void;
  needsEngine?: boolean;
  notify: (message: string) => void;
}) {
  const step = progress.step;
  const [bounds, setBounds] = useState<DOMRect>();
  useEffect(() => {
    if (step === "welcome" || hidden) return;
    const selector = copy[step].target;
    const update = () => {
      const target = document.querySelector(selector);
      setBounds(target?.getBoundingClientRect());
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step, hidden]);
  if (progress.dismissed || progress.completedAt) return null;
  if (step === "welcome")
    return (
      <Modal
        title="Make your first idea real."
        kicker="WELCOME TO MEMCODE"
        description="Your code. Your workers. A clear place to begin."
        close={() => onUpdate({ dismissed: true })}
        wide
      >
        <div className="onboarding-welcome">
          <GuideFlow />
          {needsEngine && <BetaAccess notify={notify} existingCLI />}
          <div className="guide-welcome-notes">
            <span>
              <FolderPlus size={15} />
              Keep your project local
            </span>
            <span>
              <Plug size={15} />
              Connect with your approval
            </span>
            <span>
              <MessageSquare size={15} />
              Start with one clear story
            </span>
          </div>
          <p>
            We’ll walk through the essentials together. Everything else can wait
            until you need it.
          </p>
          <footer>
            <button
              className="button secondary"
              onClick={() => onUpdate({ dismissed: true })}
            >
              Explore on my own
            </button>
            <button
              className="button primary"
              onClick={() => onUpdate({ step: "project", dismissed: false })}
            >
              Let’s get started
              <ArrowRight size={14} />
            </button>
          </footer>
        </div>
      </Modal>
    );
  const item = copy[step],
    localProject = project && !project.example,
    selectedEpic =
      epics.find((e) => e.id === progress.epicId) ??
      epics.find((e) => !e.sourceKey),
    hasStory = state.tasks.some((t) => t.id === progress.storyId);
  return (
    <>
      {!hidden && bounds && bounds.width > 0 && (
        <div
          className="onboarding-spotlight"
          aria-hidden
          style={{
            left: bounds.x - 5,
            top: bounds.y - 5,
            width: bounds.width + 10,
            height: bounds.height + 10,
          }}
        />
      )}
      <aside
        className={"onboarding-guide " + (hidden ? "suspended" : "")}
        aria-label="Getting started guide"
      >
        <header>
          <span>
            <Sparkles size={12} /> YOUR FIRST PROJECT
          </span>
          <button
            className="icon-button"
            aria-label="Pause getting started guide"
            onClick={() => onUpdate({ dismissed: true })}
          >
            <X size={14} />
          </button>
        </header>
        <div className="guide-progress" aria-label={`Step ${item.number} of 4`}>
          {[1, 2, 3, 4].map((n) => (
            <i key={n} className={n <= item.number ? "complete" : ""} />
          ))}
        </div>
        <div className="guide-step-copy" key={step}>
          <small>
            {step === "ready"
              ? "READY WHEN YOU ARE"
              : `STEP ${item.number} OF 4`}
          </small>
          <h2>{item.title}</h2>
          <p>{item.body}</p>
          {step === "project" && needsEngine && (
            <BetaAccess notify={notify} existingCLI />
          )}
          <button
            className="button primary"
            onClick={() => onAction(step === "ready" ? "open-story" : step)}
          >
            {item.button}
            <ArrowRight size={13} />
          </button>
          {step === "project" && localProject && (
            <button
              className="guide-use-existing"
              onClick={() =>
                onUpdate({ step: "worker", projectId: project.id })
              }
            >
              <Check size={12} />
              Use {project.name}
            </button>
          )}
          {step === "worker" && connected && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ step: "epic" })}
            >
              <Check size={12} />
              Worker connected · continue
            </button>
          )}
          {step === "epic" && selectedEpic && (
            <button
              className="guide-use-existing"
              onClick={() =>
                onUpdate({ step: "story", epicId: selectedEpic.id })
              }
            >
              <Layers3 size={12} />
              Use {selectedEpic.title}
            </button>
          )}
          {step === "ready" && hasStory && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ complete: true })}
            >
              <Check size={12} />
              Finish guide
            </button>
          )}
        </div>
        <footer>
          <button onClick={onDocs}>Read the quick start</button>
          <span>Continue at your own pace</span>
        </footer>
      </aside>
    </>
  );
}
