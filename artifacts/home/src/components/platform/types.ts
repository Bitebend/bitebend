import type { ComponentType, CSSProperties } from "react";

export type PlatformStatus = "active" | "coming_soon" | "beta";

export interface PlatformDefinition {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  status: PlatformStatus;
  badge?: string;
  actionLabel?: string;
  route: string;
  externalUrl?: string;
  enabled: boolean;
  note?: string;
}

export interface PlatformCardProps {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  status?: PlatformStatus;
  badge?: string;
  actionLabel?: string;
  note?: string;
  onClick?: () => void;
  className?: string;
}
