import "./browser-mock";
import "./globals.css";
import { attachConsole } from "@tauri-apps/plugin-log";
import { createRoot } from "react-dom/client";
import App from "./App";

// Wire up console forwarding to the Rust log backend.
// Non-critical — swallow errors silently.
attachConsole().catch(() => {});

createRoot(document.getElementById("app")!).render(<App />);

// Work around WebView2 blank-screen bug after laptop sleep/resume on Windows.
// When the page becomes visible again, nudge the DOM to force a repaint.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    document.body.style.opacity = "0.999";
    requestAnimationFrame(() => {
      document.body.style.opacity = "";
    });
  }
});
