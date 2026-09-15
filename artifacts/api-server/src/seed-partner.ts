import bcrypt from "bcrypt";
import { db, users, partners } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function seedPartner() {
  const email = "partner@bitebend.in";
  const password = "Partner@123";
  const name = "Bitebend Demo Partner";
  const referralCode = "BBDEMO";
  const commissionPercentage = 10.0;
  const phone = "9876543210";

  const passwordHash = await bcrypt.hash(password, 10);

  // 1. Check or upsert in users table
  const [existingUser] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  let userId: number;
  if (existingUser) {
    await db
      .update(users)
      .set({
        passwordHash,
        name,
        role: "partner",
      })
      .where(eq(users.id, existingUser.id));
    userId = existingUser.id;
    console.log(`[seed-partner] Updated existing user id=${userId}`);
  } else {
    const [insertedUser] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        name,
        role: "partner",
      })
      .returning({ id: users.id });
    userId = insertedUser.id;
    console.log(`[seed-partner] Inserted new user id=${userId}`);
  }

  // 2. Check or upsert in partners table
  const [existingPartner] = await db
    .select({ id: partners.id })
    .from(partners)
    .where(eq(partners.userId, userId))
    .limit(1);

  if (existingPartner) {
    await db
      .update(partners)
      .set({
        name,
        email,
        phone,
        referralCode,
        commissionPercentage,
        status: "active",
        payoutDetails: {
          upiId: "demopartner@upi",
          accountName: "Bitebend Demo Partner",
          accountNumber: "919876543210",
          ifsc: "HDFC0001234",
          bankName: "HDFC Bank",
        },
        updatedAt: new Date(),
      })
      .where(eq(partners.id, existingPartner.id));
    console.log(`[seed-partner] Updated existing partner id=${existingPartner.id}`);
  } else {
    const [insertedPartner] = await db
      .insert(partners)
      .values({
        userId,
        name,
        email,
        phone,
        referralCode,
        commissionPercentage,
        status: "active",
        payoutDetails: {
          upiId: "demopartner@upi",
          accountName: "Bitebend Demo Partner",
          accountNumber: "919876543210",
          ifsc: "HDFC0001234",
          bankName: "HDFC Bank",
        },
      })
      .returning({ id: partners.id });
    console.log(`[seed-partner] Inserted new partner id=${insertedPartner.id}`);
  }

  console.log(`[seed-partner] Partner account ready: ${email} / ${password} (Code: ${referralCode}, ${commissionPercentage}%)`);
}

if (process.argv[1]?.endsWith("seed-partner.ts")) {
  seedPartner()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed-partner] Failed:", err);
      process.exit(1);
    });
}
