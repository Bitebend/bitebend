import type { PlatformDefinition } from "./types";
import { UtensilsCrossed, MessageSquare } from "lucide-react";

/**
 * Bitebend Central Platform Registry
 *
 * Defines all platforms available in the Bitebend multi-platform ecosystem.
 * The Home launcher renders cards dynamically from this registry.
 * Future platforms can be added here as new definitions without modifying
 * the Home page layout or navigation architecture.
 */
export const PLATFORMS: PlatformDefinition[] = [
  {
    id: "restaurant",
    title: "Restaurant",
    description: "Discover restaurants and their services.",
    icon: UtensilsCrossed,
    status: "active",
    badge: "Platform",
    actionLabel: "Open →",
    route: "/restaurant",
    enabled: true,
  },
  {
    id: "messaging",
    title: "Messaging",
    description: "Connect and message through Bitebend.",
    icon: MessageSquare,
    status: "coming_soon",
    badge: "Coming Soon",
    actionLabel: "Open →",
    route: "/messaging",
    enabled: true,
  },
];
