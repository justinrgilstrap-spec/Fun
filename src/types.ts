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

/**
 * FBS/FCS school venue state — a 3-way pick, not a binary visited flag.
 * "campus" = been to campus/stadium grounds, "stadium" = been inside the
 * stadium, "game" = been to a game there. Mutually exclusive: setting one
 * replaces any prior state for that school, and re-picking the active state
 * clears it back to unvisited (see setVenueState in main.ts).
 */
export type VenueState = "campus" | "stadium" | "game";

export interface VisitedFile {
  countries: string[];
  states: string[];
  cities: string[];
  parks: string[];
  /**
   * FBS/FCS schools, keyed by SCHOOL_ID, valued by the 3-way VenueState.
   * Unlike every other field here, absence of a key (not an empty-string
   * entry) means "not visited" — there's no "unvisited but present" state.
   */
  fbs: Record<string, VenueState>;
  fcs: Record<string, VenueState>;
  /** MLB stadiums — simple binary "been to a game there", same shape as parks/cities. */
  mlb: string[];
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

export type LayerKind = "countries" | "states" | "cities" | "parks" | "fbs" | "fcs" | "mlb";

/**
 * LayerKinds whose visited state is a plain string[] id set, toggled on/off.
 * Excludes "fbs"/"fcs", whose visited state is a 3-way VenueState per id
 * (see setVenueState in main.ts) instead of simple membership.
 */
export type BinaryLayerKind = Exclude<LayerKind, "fbs" | "fcs">;
