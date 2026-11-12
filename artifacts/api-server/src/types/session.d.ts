import "express-session";
import type { users, restaurantStaff, restaurants } from "@workspace/db";

type DbUser = typeof users.$inferSelect;
type DbStaff = typeof restaurantStaff.$inferSelect;
type DbRestaurant = typeof restaurants.$inferSelect;

declare module "express-session" {
  interface SessionData {
    userId: number;
    sensitiveActionExpiresAt?: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: DbUser;
      staff?: DbStaff;
      restaurant?: DbRestaurant;
    }
  }
}
