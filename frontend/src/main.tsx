import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { initTheme } from "./theme.js";

// BEFORE React mounts. The attribute has to be on <html> for the first paint,
// or the page flashes the system palette and then snaps to the chosen one.
initTheme();

const root = document.getElementById("root");
// Fail loudly. A silent no-op here renders a blank page with a clean console,
// which is the single most time-consuming way for a mount bug to present.
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
