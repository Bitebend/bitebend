import "express-session";
import type { users, restaurantStaff, restaurants } from "@workspace/db";

type DbUser = typeof users.$inferSelect;
type DbStaff = typeof restaurantStaff.$inferSelect;
type DbRestaurant = typeof restaurants.$inferSelect;

export interface ProfilePinSessionUnlock {
  pinVersion: number;
  expiresAt: number;
}

declare module "express-session" {
  interface SessionData {
    userId: number;
    sensitiveActionExpiresAt?: number;
    profilePinUnlocks?: Record<string, ProfilePinSessionUnlock>;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: DbUser;
      staff?: DbStaff;
      restaurant?: DbRestaurant;
      profilePinUnlock?: {
        restaurantId: number;
        ownerUserId: number;
        pinVersion: number;
        source: "session" | "header";
      };
    }
  }
}
