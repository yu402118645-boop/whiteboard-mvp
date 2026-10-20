import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { Board } from "./Board";
import { Home } from "./Home";

const match = location.pathname.match(/^\/b\/([A-Za-z0-9_-]+)\/?$/);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{match ? <Board boardId={match[1]} /> : <Home />}</StrictMode>,
);
