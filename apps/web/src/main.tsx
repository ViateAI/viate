import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { intlLocale } from "./format";
import { m } from "./paraglide/messages.js";
import { getLocale, getTextDirection } from "./paraglide/runtime.js";
import "./styles.css";

document.documentElement.lang = intlLocale();
document.documentElement.dir = getTextDirection(getLocale());

const path = window.location.pathname.replace(/\/+$/, "") || "/";
document.title =
  path === "/portal" || path.startsWith("/portal/") ? m.document_title_portal() : m.document_title_admin();

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
