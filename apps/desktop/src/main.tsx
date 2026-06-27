import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

if (!window.dinorip) {
  window.dinorip = {
    platform: "browser",
    openImages: async () => ({ canceled: true, images: [] }),
    savePng: async () => ({ canceled: true, paths: [] }),
    exportAllPng: async () => ({ canceled: true, paths: [] }),
    saveProject: async () => ({ canceled: true, paths: [] }),
    openProject: async () => ({ canceled: true }),
    onMenuCommand: () => () => {},
    toggleFullscreen: async () => false
  };
}

if (import.meta.env.DEV) {
  void import("./renderer/benchmark").then(({ installBenchmark }) => installBenchmark());
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
