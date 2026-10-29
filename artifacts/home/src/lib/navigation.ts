/**
 * Bitebend Navigation Utilities (P3)
 */

/**
 * Constructs the canonical public customer menu URL for a given restaurant slug.
 *
 * - In production: resolves to https://menu.bitebend.in/:slug
 * - In preview / staging / localhost: resolves to /menu/:slug served by the unified server
 */
export function getRestaurantMenuUrl(slug: string): string {
  if (typeof window === "undefined") {
    return `/menu/${slug}`;
  }

  const host = window.location.hostname.toLowerCase();

  if (host === "bitebend.in" || host === "www.bitebend.in") {
    return `https://menu.bitebend.in/${slug}`;
  }

  if (host === "menu.bitebend.in") {
    return `/${slug}`;
  }

  // Localhost, Cloud Run preview, dev server
  return `/menu/${slug}`;
}
