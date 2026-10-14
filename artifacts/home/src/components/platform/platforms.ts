import type { PlatformDefinition } from "./types";
import { UtensilsCrossed, MessageSquare } from "lucide-react";

/**
 * Bitebend Central Platform Registry
 *
 * Defines all platforms available in the Bitebend multi-platform ecosystem.
 * The Home launcher renders cards dynamically from this registry.
 * Future platforms can easily be registered here without redesigning the Home layout.
 */
export const PLATFORMS: PlatformDefinition[] = [
  {
    id: "restaurant",
    title: "Restaurant",
    description: "Discover restaurants, digital menus, contactless ordering, and table service.",
    icon: UtensilsCrossed,
    status: "active",
    badge: "Platform",
    actionLabel: "Open →",
    route: "/restaurant",
    externalUrl: "https://menu.bitebend.in",
    enabled: true,
  },
  {
    id: "messaging",
    title: "Messaging",
    description: "Connect, chat, and message in real time with restaurants and friends.",
    icon: MessageSquare,
    status: "coming_soon",
    badge: "Coming Soon",
    actionLabel: "Open →",
    route: "/messaging",
    enabled: true,
  },
];
