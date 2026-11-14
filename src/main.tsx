import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { App } from "./App";
import { installNativeBridge } from "./tauri";

const root = createRoot(document.getElementById("root")!);
void installNativeBridge()
  .then(() =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  )
  .catch((error) =>
    root.render(
      <div className="boot-screen">
        <h1>MemCode could not connect.</h1>
        <p>{error.message}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>,
    ),
  );
