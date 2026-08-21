import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./shell/tokens.css";
import "./shell/shell.css";
import "./stage1/stage1.css";
import "./styles.css";

const root = document.querySelector("#root");

if (root === null) {
  throw new Error("アプリケーションの表示領域が見つかりません。");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
