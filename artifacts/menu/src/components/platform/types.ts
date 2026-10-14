import type { ComponentType, CSSProperties } from "react";

export type PlatformStatus = "active" | "coming_soon" | "beta" | "preview";

export interface RecentRestaurantSession {
  slug: string;
  name: string;
  tableId?: string | number | null;
  tableNumber?: string | null;
  visitedAt?: number;
}

export interface PlatformDefinition {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  status: PlatformStatus;
  badge?: string;
  note?: string;
  actionLabel: string;
  route: string;
  enabled: boolean;
}

export interface PlatformCardProps {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  route?: string;
  badge?: string;
  status?: PlatformStatus;
  note?: string;
  actionLabel?: string;
  onClick?: () => void;
  disabled?: boolean;
}
