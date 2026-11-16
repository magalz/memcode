import { useEffect, useState } from "react";
import { ArrowRight, Check, Pause, Play } from "lucide-react";
import type { ReactNode } from "react";
import { shortcutLabel } from "../platform";
import { Mark } from "./UI";
import "../styles-install-welcome.css";

const previews = [
  {
    name: "Plan your work",
    label: "YOUR WORK, IN FOCUS",
    heading: "Build what\ncomes next.",
    body: "Give an idea a clear story. Bring in your workers. Keep the work moving, from the first brief to the final review.",
    image: "workspace",
    caption: "A place for the plan. And the people making it happen.",
  },
  {
    name: "Understand the code",
    label: "CODE, WITH CONTEXT",
    heading: "A clearer view.\nA better next move.",
    body: "Memtrace brings local code context, measured complexity and change impact into the work, so model routing starts with evidence.",
    image: "insights",
    caption: "Understand the code before you change it.",
  },
  {
    name: "Stay close to the work",
    label: "EVERY STORY, TOGETHER",
    heading: "See the work.\nShape the next step.",
    body: "Keep the brief, conversation, changes and saved output with the story. Review what happened, then guide what happens next.",
    image: "story",
    caption: "Less searching for context. More room to build.",
  },
] as const;

/** Product introduction only. The existing guide owns device-local persistence. */
export function InstallWelcome({
  preference,
  onSkip,
  onContinue,
}: {
  preference: ReactNode;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    const updateVisibility = () => setVisible(!document.hidden);
    updateMotion();
    updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  useEffect(() => {
    if (paused || reducedMotion || !visible) return;
    const timer = window.setInterval(
      () => setActive((value) => (value + 1) % previews.length),
      7200,
    );
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion, visible]);
  const select = (index: number) => {
    setPaused(true);
    setActive((index + previews.length) % previews.length);
  };
  const current = previews[active];
  return (
    <div className="install-welcome" data-preview={active}>
      <section className="install-welcome-copy" aria-label="Welcome to MemCode">
        <div className="install-welcome-brand">
          <Mark />
          <div>
            <strong>MemCode</strong>
            <span>THE FLEET WORKER SUITE</span>
          </div>
        </div>
        <div className="install-welcome-message" key={active}>
          <span className="install-welcome-eyebrow">
            <i /> WELCOME TO WHAT’S NEXT
          </span>
          <h3>{current.heading}</h3>
          <p>{current.body}</p>
        </div>
        <ul className="install-welcome-promises">
          <li>
            <Check size={13} /> Your projects stay local
          </li>
          <li>
            <Check size={13} /> Workers connect with your approval
          </li>
          <li>
            <Check size={13} /> Start with one idea, at your own pace
          </li>
        </ul>
        <div className="install-welcome-actions">
          <button className="button primary" onClick={onContinue}>
            Let’s get started <ArrowRight size={15} />
          </button>
          <button className="install-welcome-skip" onClick={onSkip}>
            Skip for now
          </button>
          {preference}
        </div>
        <div className="install-welcome-footnote">
          <span>Find setup help in Docs → Guide me through.</span>
          <span>
            Find your work <kbd>{shortcutLabel("K")}</kbd>
          </span>
        </div>
      </section>
      <section
        className="install-welcome-stage"
        role="region"
        aria-roledescription="carousel"
        aria-label="MemCode product preview"
      >
        <div className="install-welcome-stage-grid" aria-hidden="true" />
        <div className="install-welcome-stage-top">
          <span>
            <i /> {current.label}
          </span>
          <span>PRODUCT PREVIEW</span>
        </div>
        <div className="install-welcome-screen" aria-hidden="true">
          <div className="install-welcome-screen-bar">
            <span>
              <i />
              <i />
              <i />
            </span>
            <span>MemCode</span>
            <span className="install-welcome-screen-local">
              <i /> Local workspace
            </span>
          </div>
          <div className="install-welcome-screen-images">
            {previews.map((preview, index) => (
              <img
                key={preview.image}
                src={`./guide/${preview.image}.png`}
                alt=""
                className={index === active ? "is-active" : ""}
                draggable={false}
              />
            ))}
          </div>
        </div>
        <div className="install-welcome-stage-bottom">
          <p>{current.caption}</p>
          <span>Screenshots show example and setup views.</span>
          <div className="install-welcome-carousel-controls">
            <div
              className="install-welcome-pages"
              role="group"
              aria-label="Choose a product preview"
              onFocusCapture={() => setPaused(true)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft")
                  return;
                event.preventDefault();
                select(active + (event.key === "ArrowRight" ? 1 : -1));
              }}
            >
              {previews.map((preview, index) => (
                <button
                  key={preview.name}
                  className={index === active ? "is-active" : ""}
                  onClick={() => select(index)}
                  aria-label={`Show ${preview.name.toLowerCase()} preview`}
                  aria-current={index === active ? "true" : undefined}
                >
                  <span />
                </button>
              ))}
            </div>
            {!reducedMotion && (
              <button
                className="install-welcome-playback"
                onClick={() => setPaused((value) => !value)}
                aria-label={
                  paused ? "Play product preview" : "Pause product preview"
                }
              >
                {paused ? <Play size={11} /> : <Pause size={11} />}
                {paused ? "Play preview" : "Pause preview"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
