import type { ImportResult } from "../types";
import { parseTimeline } from "./parser";
import { showToast } from "../ui/toast";

type Handler = (result: ImportResult, fileName: string) => void | Promise<void>;

export function setupDropzone(
  el: HTMLElement,
  fileInput: HTMLInputElement,
  onImport: Handler,
): void {
  const handleFile = async (file: File) => {
    el.classList.add("processing");
    el.classList.remove("drag-over");
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = parseTimeline(json);
      await onImport(result, file.name);
    } catch (err) {
      console.error("Failed to import:", err);
      // Tauri's invoke() rejects with the raw error value from the Rust/plugin
      // side (often a plain string, e.g. a denied fs-scope permission) rather
      // than an Error instance, so `(err as Error).message` can silently be
      // undefined. Fall back to the value itself (or a generic message) so the
      // toast always shows something readable.
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
      showToast(`Failed to import ${file.name}: ${message}`, {
        variant: "error",
        duration: 7000,
      });
    } finally {
      el.classList.remove("processing");
    }
  };

  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drag-over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = "";
  });
}
