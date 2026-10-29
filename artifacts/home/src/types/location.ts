/**
 * Bitebend Customer Location Types (P2 Foundation)
 *
 * Defines the client-side customer location contract.
 * P3 Restaurant Discovery will consume this contract to filter and rank nearby restaurants.
 */

export type LocationMode = "gps" | "manual";

export interface CustomerLocation {
  mode: LocationMode;
  latitude: number | null;
  longitude: number | null;
  locality: string | null;
  city: string | null;
  displayName: string;
  accuracyMeters?: number | null;
  timestamp: number;
}

export interface ManualLocationInput {
  city: string;
  locality?: string;
}

export interface CustomerLocationContextType {
  location: CustomerLocation | null;
  isDetecting: boolean;
  error: string | null;
  detectLocation: () => Promise<CustomerLocation | null>;
  setManualLocation: (input: ManualLocationInput) => void;
  clearLocation: () => void;
  clearError: () => void;
}
