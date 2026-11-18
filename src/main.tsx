import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootRoughcut } from "./app/boot";
import "./ui/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// Picks the core (real inside Tauri, stand-in in a browser), makes the store, publishes
// window.__roughcut and sets up the address's scenario (src/app/boot.ts).
const { store } = bootRoughcut(window);

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
