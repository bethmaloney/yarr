import "./browser-mock";
import "./globals.css";
import { attachConsole } from "@tauri-apps/plugin-log";
import { createRoot } from "react-dom/client";
import App from "./App";

// Wire up console forwarding to the Rust log backend.
// Non-critical — swallow errors silently.
attachConsole().catch(() => {});

createRoot(document.getElementById("app")!).render(<App />);
