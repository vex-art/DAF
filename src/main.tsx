import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DelayedAuditoryFeedback from "./component/DAF";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DelayedAuditoryFeedback />
  </StrictMode>
);
