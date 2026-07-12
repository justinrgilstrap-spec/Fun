import type { ImportResult, Visit } from "../types";

/**
 * Google Photos Takeout per-photo sidecar JSON (e.g.
 * "IMG_1234.jpg.supplemental-metadata.json", sitting next to the actual photo
 * file in the exported "Google Photos" folder). Duck-typed rather than
 * strictly validated, since Google has used a couple of variant filenames
 * across export versions, but the payload shape itself — title, creationTime,
 * photoTakenTime, geoData, people, url — has been stable.
 */
interface PhotoSidecar {
  photoTakenTime?: { timestamp?: string };
  geoData?: { latitude?: number; longitude?: number };
}

function looksLikePhotoSidecar(json: unknown): json is PhotoSidecar {
  if (!json || typeof json !== "object") return false;
  const ptt = (json as Record<string, unknown>).photoTakenTime;
  return !!ptt && typeof ptt === "object" && "timestamp" in ptt;
}

/** True for any file worth attempting to parse as a sidecar — cheap filename
 *  check the batch reader below uses to skip the actual photo/video binaries
 *  in a mixed folder without wasting a read+JSON.parse on each one. */
export function looksLikeSidecarFilename(name: string): boolean {
  return name.toLowerCase().endsWith(".json");
}

/**
 * Read and parse a batch of Google Photos Takeout sidecar files, extracting
 * each geotagged photo as a zero-duration Visit (startTime === endTime ===
 * when the photo was taken). That's the exact same shape joinVisits() already
 * consumes for Google Timeline imports — no spatial-join changes needed at
 * all, this just gives it a second source of Visits to join.
 *
 * Non-photo Takeout files (album metadata, sharing settings, print-order
 * receipts, etc.) don't have a photoTakenTime and are silently skipped, same
 * as photos with no recorded location — Google Takeout uses (0, 0) as its
 * "no location" sentinel (rather than omitting the field), which would
 * otherwise misread as a visit to the literal middle of the Gulf of Guinea.
 */
export async function parseGooglePhotosSidecars(files: File[]): Promise<ImportResult> {
  const visits: Visit[] = [];
  // Read in batches rather than one giant Promise.all — a real export can be
  // tens of thousands of small files; unbounded parallel reads risk a memory
  // spike, while fully sequential awaits would be needlessly slow.
  const BATCH = 500;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const parsed = await Promise.all(
      batch.map(async (file) => {
        try {
          return JSON.parse(await file.text()) as unknown;
        } catch {
          return null; // Not every .json in a Takeout export is a photo sidecar.
        }
      }),
    );
    for (const json of parsed) {
      if (!looksLikePhotoSidecar(json)) continue;
      const lat = json.geoData?.latitude;
      const lon = json.geoData?.longitude;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (lat === 0 && lon === 0) continue; // Google's "no location recorded" sentinel.
      const tsSeconds = Number(json.photoTakenTime?.timestamp);
      if (!Number.isFinite(tsSeconds)) continue;
      const ts = tsSeconds * 1000;
      visits.push({ lat, lon, startTime: ts, endTime: ts });
    }
  }
  return { points: [], visits };
}
