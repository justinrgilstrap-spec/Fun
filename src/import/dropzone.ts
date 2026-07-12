import type { ImportResult } from "../types";
import { parseTimeline } from "./parser";
import { parseGooglePhotosSidecars, looksLikeSidecarFilename } from "./googlePhotos";
import { showToast } from "../ui/toast";

type Handler = (result: ImportResult, fileName: string) => void | Promise<void>;

/**
 * True for the handful of top-level shapes a Google Timeline export can take
 * (see parseTimeline in ./parser). Anything else — including a lone .json
 * that isn't Timeline-shaped — falls through to the Google Photos batch path
 * below, so dropping a single sidecar file (e.g. to try the feature) still
 * works the same as dropping a whole folder of them.
 */
function isTimelineShaped(json: unknown): boolean {
  if (Array.isArray(json)) return true; // on-device semanticSegments array form
  if (!json || typeof json !== "object") return false;
  const o = json as Record<string, unknown>;
  return (
    Array.isArray(o.locations) ||
    Array.isArray(o.timelineObjects) ||
    Array.isArray(o.semanticSegments) ||
    Array.isArray(o.rawSignals)
  );
}

// Recursively collects every File under a dropped FileSystemEntry (folder or
// single file). Only reachable via drag-and-drop's DataTransferItem API —
// there's no equivalent for the <input type="file"> fallback, which instead
// gets folder support from its own webkitdirectory attribute (set in
// index.html) and lets the browser flatten that to a FileList directly.
async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries() only returns one batch per call and must be called
    // repeatedly until it returns an empty array — a quirk of the spec, not
    // a bug here.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

export function setupDropzone(
  el: HTMLElement,
  fileInput: HTMLInputElement,
  onImport: Handler,
): void {
  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    el.classList.add("processing");
    el.classList.remove("drag-over");
    try {
      // A single .json that parses as a Timeline export keeps the original
      // single-file behavior exactly as before.
      if (files.length === 1 && files[0].name.toLowerCase().endsWith(".json")) {
        const text = await files[0].text();
        const json = JSON.parse(text);
        if (isTimelineShaped(json)) {
          const result = parseTimeline(json);
          await onImport(result, files[0].name);
          return;
        }
      }
      // Anything else — multiple files, a dropped folder, or a lone file that
      // wasn't Timeline-shaped — is treated as a batch of Google Photos
      // Takeout sidecar files. Filenames that obviously aren't JSON (the
      // actual photo/video binaries sitting alongside their sidecars) are
      // skipped before even attempting a read.
      const jsonFiles = files.filter((f) => looksLikeSidecarFilename(f.name));
      if (jsonFiles.length === 0) {
        showToast("No .json files found — drop your Timeline export or a Google Photos folder.", {
          variant: "error",
          duration: 7000,
        });
        return;
      }
      const result = await parseGooglePhotosSidecars(jsonFiles);
      const label = `Google Photos export (${jsonFiles.length.toLocaleString()} file${jsonFiles.length === 1 ? "" : "s"})`;
      await onImport(result, label);
    } catch (err) {
      console.error("Failed to import:", err);
      // Tauri's invoke() rejects with the raw error value from the Rust/plugin
      // side (often a plain string, e.g. a denied fs-scope permission) rather
      // than an Error instance, so `(err as Error).message` can silently be
      // undefined. Fall back to the value itself (or a generic message) so the
      // toast always shows something readable.
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
      showToast(`Failed to import: ${message}`, {
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
    const items = e.dataTransfer?.items;
    const first = items?.[0];
    if (items && first && typeof first.webkitGetAsEntry === "function") {
      void (async () => {
        const files: File[] = [];
        for (const item of Array.from(items)) {
          const entry = item.webkitGetAsEntry();
          if (entry) await walkEntry(entry, files);
        }
        await handleFiles(files);
      })();
      return;
    }
    // Fallback for browsers/contexts without the entry API: flat file list
    // only (no folder-drop support), but multi-file drop still works.
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void handleFiles(Array.from(files));
  });

  fileInput.addEventListener("change", () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    if (files.length > 0) void handleFiles(files);
    fileInput.value = "";
  });
}
