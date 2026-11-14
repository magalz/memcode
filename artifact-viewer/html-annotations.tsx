import { createRoot } from "react-dom/client";
import SelectionTools from "./selection";
import Annotations from "./annotations";
import "./selection-tools.css";
import "../src/styles-annotations.css";
const mount = document.createElement("div");
mount.id = "memcode-artifact-review";
document.body.append(mount);
createRoot(mount).render(
  <>
    <SelectionTools />
    <Annotations />
  </>,
);
