import type { ComponentType, CSSProperties } from "react";

export interface PlatformCardProps {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  route?: string;
  badge?: string;
  status?: "active" | "coming_soon" | "beta";
  note?: string;
  actionLabel?: string;
  onClick?: () => void;
  disabled?: boolean;
}
