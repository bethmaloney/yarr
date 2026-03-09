import "./browser-mock";
import "./globals.css";
import { createRoot } from "react-dom/client";

function Placeholder() {
  return <div>React works</div>;
}

createRoot(document.getElementById("app")!).render(<Placeholder />);
