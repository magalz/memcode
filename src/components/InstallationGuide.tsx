import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, FolderOpen, HardDrive, X } from "lucide-react";
import "../styles-installation-guide.css";

/** A disk image is an installer, not a writable home for app updates. */
export function InstallationGuide() {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    void window.memcode
      .installationStatus()
      .then((status) => {
        if (live) setVisible(status.needsInstall);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [visible]);
  if (!visible) return null;
  const open = async (action: () => Promise<void>) => {
    try {
      await action();
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <div className="installation-guide-backdrop">
      <section
        ref={panel}
        className="installation-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="installation-guide-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const buttons = [
            ...panel.current!.querySelectorAll<HTMLButtonElement>("button"),
          ];
          if (
            event.shiftKey &&
            (document.activeElement === buttons[0] ||
              document.activeElement === panel.current)
          ) {
            event.preventDefault();
            buttons.at(-1)?.focus();
          } else if (
            !event.shiftKey &&
            document.activeElement === buttons.at(-1)
          ) {
            event.preventDefault();
            buttons[0]?.focus();
          }
        }}
      >
        <header>
          <span className="eyebrow">A HOME FOR YOUR WORK</span>
          <button
            className="icon-button"
            aria-label="Continue preview"
            onClick={() => setVisible(false)}
          >
            <X size={16} />
          </button>
        </header>
        <div className="installation-guide-symbol">
          <HardDrive size={24} />
          <ArrowRight size={16} />
          <FolderOpen size={28} />
        </div>
        <h1 id="installation-guide-title">Install once. Keep building.</h1>
        <p>
          You opened MemCode from a temporary or read-only location. Move it
          into Applications for reliable launches and in-app updates.
        </p>
        <ol>
          <li>
            <span>1</span>
            <div>
              <strong>Drag MemCode into Applications.</strong>
              <small>
                Open the installation disk below to find both icons.
              </small>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open MemCode from Applications.</strong>
              <small>
                Quit this copy, eject the disk, and launch your installed app.
              </small>
            </div>
          </li>
        </ol>
        <p className="installation-guide-kept">
          <Check size={14} /> Your projects, connections and downloaded models
          stay saved.
        </p>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="button secondary"
            onClick={() =>
              void open(() => window.memcode.showInstallationSource())
            }
          >
            Show installation disk
          </button>
          <button
            className="button primary"
            onClick={() => void open(() => window.memcode.showApplications())}
          >
            Open Applications
            <ArrowRight size={13} />
          </button>
        </footer>
        <button
          className="text-button installation-guide-preview"
          onClick={() => setVisible(false)}
        >
          Explore first
        </button>
      </section>
    </div>
  );
}
