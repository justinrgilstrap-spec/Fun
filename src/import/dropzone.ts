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
      showToast(`Failed to import ${file.name}: ${(err as Error).message}`, {
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
