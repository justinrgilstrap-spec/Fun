export interface RawPoint {
  lat: number;
  lon: number;
  timestamp: number;
}

export interface Visit {
  lat: number;
  lon: number;
  startTime: number;
  endTime: number;
  placeName?: string;
  placeId?: string;
}

export interface ImportResult {
  points: RawPoint[];
  visits: Visit[];
}

/**
 * Optional home location. Coordinates are snapped to the nearest dataset city, so
 * what's stored (and published to the public web build) is a coarse, well-known
 * city centroid — never the user's precise GPS. `label` is that city's name.
 */
export interface HomePoint {
  lat: number;
  lon: number;
  label: string;
}

export interface VisitedFile {
  countries: string[];
  states: string[];
  cities: string[];
  /** Optional home pin (additive, backward-compatible). */
  home?: HomePoint;
  updatedAt: number;
}

export interface RawTimelineImport {
  source: string;
  importedAt: number;
  visits: Visit[];
  points: RawPoint[];
}

export type LayerKind = "countries" | "states" | "cities";
