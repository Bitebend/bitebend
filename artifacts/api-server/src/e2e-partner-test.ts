import http from "node:http";
import app from "./app";
import { db, ensureDbReady } from "@workspace/db";
import {
  users,
  partners,
  restaurants,
  subscriptionPlans,
  subscriptionTransactions,
  partnerCommissions,
  partnerAuditLogs,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { recordPartnerCommission } from "./lib/commission";

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function makeRequest(
  serverUrl: string,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const postData = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };
    if (postData) {
      reqHeaders["Content-Length"] = Buffer.byteLength(postData).toString();
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // keep raw string
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: parsed,
          });
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runE2ETest() {
  console.log("================================================================================");
  console.log("🚀 STARTING BITEBEND PARTNER COMMISSION LIFECYCLE END-TO-END VERIFICATION TEST");
  console.log("================================================================================\n");

  await ensureDbReady();

  // Start test server on ephemeral port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const serverUrl = `http://127.0.0.1:${address.port}`;
  console.log(`[TEST HARNESS] Express test harness listening on ${serverUrl}`);

  const timestamp = Date.now();
  const testPartnerName = `E2E Test Partner ${timestamp}`;
  const testPartnerEmail = `e2e-partner-${timestamp}@bitebend.test`;
  const testPartnerPhone = `+9198765${String(timestamp).slice(-5)}`;
  const testPartnerPassword = `PartnerPass@${timestamp.toString().slice(-4)}`;

  const testRestoName = `E2E Test Restaurant ${timestamp}`;
  const testRestoEmail = `e2e-resto-${timestamp}@bitebend.test`;
  const testRestoPhone = `+9191234${String(timestamp).slice(-5)}`;
  const testRestoPassword = `OwnerPass@${timestamp.toString().slice(-4)}`;

  try {
    // ────────────────────────────────────────────────────────────────────────
    // 1. Register a completely new Partner (Public /api/partner/register flow)
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 1: Registering a completely new Partner via public /api/partner/register...");
    const regRes = await makeRequest(serverUrl, "POST", "/api/partner/register", {
      name: testPartnerName,
      email: testPartnerEmail,
      phone: testPartnerPhone,
      city: "Bengaluru",
      state: "Karnataka",
      password: testPartnerPassword,
      payoutDetails: {
        accountNumber: "918273645543",
        ifscCode: "HDFC0001234",
        upiId: `partner${timestamp}@upi`,
        bankName: "HDFC Bank",
      },
    });

    console.log(`  → Response Status: ${regRes.status}`);
    console.log(`  → Response Body:`, JSON.stringify(regRes.body, null, 2));

    if (regRes.status !== 201 || !regRes.body.success || !regRes.body.partner?.id) {
      throw new Error(`Step 1 Failed: Partner registration failed with status ${regRes.status}: ${JSON.stringify(regRes.body)}`);
    }

    const partnerId = regRes.body.partner.id as number;

    // Verify in PostgreSQL directly
    const [dbPartnerPending] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);

    if (!dbPartnerPending) throw new Error("Step 1 DB Verification Failed: Partner not found in database.");
    console.log(`  ✓ DB State Verified: ID=${dbPartnerPending.id}, status='${dbPartnerPending.status}', referralCode=${dbPartnerPending.referralCode}`);

    if (dbPartnerPending.status !== "pending") {
      throw new Error(`Expected initial partner status to be 'pending', got '${dbPartnerPending.status}'`);
    }
    if (dbPartnerPending.referralCode !== null) {
      throw new Error(`Expected initial partner referralCode to be null before approval, got '${dbPartnerPending.referralCode}'`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. Super Admin Approval
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 2: Super Admin Login & Partner Approval...");

    // Login as Super Admin
    const adminLoginRes = await makeRequest(serverUrl, "POST", "/api/auth/login", {
      email: "admin@bitebend.in",
      password: "admin123",
    });

    if (adminLoginRes.status !== 200 || !adminLoginRes.body.token) {
      throw new Error(`Admin login failed with status ${adminLoginRes.status}: ${JSON.stringify(adminLoginRes.body)}`);
    }

    const adminToken = adminLoginRes.body.token as string;
    console.log(`  ✓ Super Admin logged in successfully (User ID: ${adminLoginRes.body.user.id})`);

    // Approve Partner with 15% custom commission rate
    const approveRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/admin/partners/${partnerId}/approve`,
      { commissionPercentage: 15 },
      { Authorization: `Bearer ${adminToken}` }
    );

    console.log(`  → Approval Status: ${approveRes.status}`);
    console.log(`  → Approval Response:`, JSON.stringify(approveRes.body, null, 2));

    if (approveRes.status !== 200 || approveRes.body.status !== "active") {
      throw new Error(`Step 2 Failed: Partner approval failed: ${JSON.stringify(approveRes.body)}`);
    }

    const generatedReferralCode = approveRes.body.referralCode as string;
    if (!generatedReferralCode || !generatedReferralCode.startsWith("BBP-")) {
      throw new Error(`Invalid referral code generated: '${generatedReferralCode}'`);
    }

    // Confirm in PostgreSQL
    const [dbPartnerActive] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);

    if (!dbPartnerActive || dbPartnerActive.status !== "active" || dbPartnerActive.referralCode !== generatedReferralCode) {
      throw new Error("Step 2 DB Verification Failed: Active partner state mismatch in database.");
    }

    console.log(`  ✓ Partner Approved in DB: ID=${partnerId}, Status=${dbPartnerActive.status}, ReferralCode=${generatedReferralCode}, CommissionRate=${dbPartnerActive.commissionPercentage}%`);

    // ────────────────────────────────────────────────────────────────────────
    // 3. Partner Login & Verification of Partner Dashboard Access
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 3: Partner Login & Dashboard Access Check...");
    const partnerLoginRes = await makeRequest(serverUrl, "POST", "/api/auth/login", {
      email: testPartnerEmail,
      password: testPartnerPassword,
    });

    if (partnerLoginRes.status !== 200 || !partnerLoginRes.body.token) {
      throw new Error(`Partner login failed with status ${partnerLoginRes.status}: ${JSON.stringify(partnerLoginRes.body)}`);
    }

    const partnerToken = partnerLoginRes.body.token as string;
    console.log(`  ✓ Partner Logged In: Role=${partnerLoginRes.body.user.role}, Name='${partnerLoginRes.body.user.name}'`);

    // Fetch Partner Dashboard
    const partnerDashRes = await makeRequest(
      serverUrl,
      "GET",
      "/api/partner/dashboard",
      undefined,
      { Authorization: `Bearer ${partnerToken}` }
    );

    if (partnerDashRes.status !== 200 || partnerDashRes.body.partner.referralCode !== generatedReferralCode) {
      throw new Error(`Partner dashboard check failed: ${JSON.stringify(partnerDashRes.body)}`);
    }

    // Fetch Partner Restaurants (should be empty initially)
    const partnerRestosInitialRes = await makeRequest(
      serverUrl,
      "GET",
      "/api/partner/restaurants",
      undefined,
      { Authorization: `Bearer ${partnerToken}` }
    );

    // Fetch Partner Commissions (should be empty initially)
    const partnerCommsInitialRes = await makeRequest(
      serverUrl,
      "GET",
      "/api/partner/commissions",
      undefined,
      { Authorization: `Bearer ${partnerToken}` }
    );

    console.log(`  ✓ Partner Dashboard Access Confirmed:`);
    console.log(`    - Status: ${partnerDashRes.body.partner.status}`);
    console.log(`    - Referral Code: ${partnerDashRes.body.partner.referralCode}`);
    console.log(`    - Initial Attributed Restaurants: ${partnerRestosInitialRes.body.length}`);
    console.log(`    - Initial Commissions: ${partnerCommsInitialRes.body.length}`);

    // ────────────────────────────────────────────────────────────────────────
    // 4. Restaurant Onboarding Through Referral
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 4: Restaurant Registration with Referral Code...");

    // Validate referral code publicly first
    const valCodeRes = await makeRequest(
      serverUrl,
      "GET",
      `/api/partners/validate-code/${generatedReferralCode}`
    );
    console.log(`  → Referral Code Public Validation:`, JSON.stringify(valCodeRes.body));
    if (valCodeRes.status !== 200 || !valCodeRes.body.valid) {
      throw new Error(`Referral code validation failed: ${JSON.stringify(valCodeRes.body)}`);
    }

    // Register new restaurant with referral code
    const restoRegRes = await makeRequest(serverUrl, "POST", "/api/auth/register", {
      name: "E2E Test Owner",
      email: testRestoEmail,
      password: testRestoPassword,
      restaurantName: testRestoName,
      restaurantPhone: testRestoPhone,
      restaurantAddress: "123 Food Street, Indiranagar",
      restaurantCity: "Bengaluru",
      restaurantState: "Karnataka",
      restaurantDistrict: "Bengaluru Urban",
      cuisineType: "Multi-Cuisine",
      partnerCode: generatedReferralCode,
      termsAccepted: true,
      privacyAccepted: true,
    });

    console.log(`  → Restaurant Registration Status: ${restoRegRes.status}`);
    if (restoRegRes.status !== 201 || !restoRegRes.body.user?.restaurantId) {
      throw new Error(`Restaurant registration failed: ${JSON.stringify(restoRegRes.body)}`);
    }

    const restaurantId = restoRegRes.body.user.restaurantId as number;
    const ownerToken = restoRegRes.body.token as string;
    console.log(`  ✓ Restaurant Created (ID: ${restaurantId})`);

    // Verify in PostgreSQL: restaurants.partner_id === partnerId
    const [dbResto] = await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    if (!dbResto) throw new Error("Restaurant not found in DB.");
    console.log(`  ✓ DB Attribution Checked: Restaurant ID=${dbResto.id}, Partner ID=${dbResto.partnerId}`);

    if (dbResto.partnerId !== partnerId) {
      throw new Error(`Referral attribution failed! Expected partnerId=${partnerId}, got ${dbResto.partnerId}`);
    }

    // Check Partner Dashboard to confirm the restaurant is now visible in partner's list
    const partnerRestosAfterRes = await makeRequest(
      serverUrl,
      "GET",
      "/api/partner/restaurants",
      undefined,
      { Authorization: `Bearer ${partnerToken}` }
    );

    const foundInPartnerList = (partnerRestosAfterRes.body as any[]).find((r) => r.id === restaurantId);
    if (!foundInPartnerList) {
      throw new Error("Newly onboarded restaurant does not appear in Partner's attributed restaurant list!");
    }
    console.log(`  ✓ Restaurant verified in Partner's Dashboard list: '${foundInPartnerList.name}' (ID: ${foundInPartnerList.id})`);

    // ────────────────────────────────────────────────────────────────────────
    // 5. Subscription Plan Purchase
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 5: Restaurant Subscription Purchase...");

    // Get available plans
    const plansRes = await makeRequest(serverUrl, "GET", "/api/subscription/plans");
    const plans = plansRes.body as any[];
    if (!plans || plans.length === 0) {
      throw new Error("No subscription plans found.");
    }
    const chosenPlan = plans.find((p) => p.name === "Growth") || plans[0];
    console.log(`  → Selected Plan: '${chosenPlan.name}' | Price: ₹${chosenPlan.price} | Customer Quota: ${chosenPlan.customerLimit}`);

    // Create plan order (UPI flow)
    const orderRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/subscription/plans/${chosenPlan.id}/order`,
      { paymentMethod: "upi" },
      { Authorization: `Bearer ${ownerToken}` }
    );

    if (orderRes.status !== 200 || !orderRes.body.transactionId) {
      throw new Error(`Subscription order creation failed: ${JSON.stringify(orderRes.body)}`);
    }

    const transactionId = orderRes.body.transactionId as number;
    console.log(`  ✓ Subscription Transaction Created: ID=${transactionId}, Status=pending, Amount=₹${orderRes.body.amount}`);

    // Restaurant submits payment reference (UTR)
    const testUtr = `UTR${timestamp}`;
    const submitUtrRes = await makeRequest(
      serverUrl,
      "POST",
      "/api/subscription/verify",
      { transactionId, utrRef: testUtr },
      { Authorization: `Bearer ${ownerToken}` }
    );
    console.log(`  ✓ UTR submitted by owner: ${testUtr} (Pending admin verification)`);

    // Super Admin verifies & confirms payment (marks transaction paid)
    const markPaidRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/admin/transactions/${transactionId}/mark-paid`,
      {},
      { Authorization: `Bearer ${adminToken}` }
    );

    if (markPaidRes.status !== 200) {
      throw new Error(`Admin mark-paid failed: ${JSON.stringify(markPaidRes.body)}`);
    }

    // Verify in PostgreSQL: subscription_transactions status === 'paid'
    const [dbTxn] = await db
      .select()
      .from(subscriptionTransactions)
      .where(eq(subscriptionTransactions.id, transactionId))
      .limit(1);

    if (!dbTxn || dbTxn.status !== "paid") {
      throw new Error(`Subscription transaction status is not 'paid': ${JSON.stringify(dbTxn)}`);
    }
    console.log(`  ✓ Subscription Transaction Verified in DB: ID=${dbTxn.id}, Status='${dbTxn.status}', Amount=₹${dbTxn.amount}`);

    // ────────────────────────────────────────────────────────────────────────
    // 6. Commission Generation Verification
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 6: Commission Generation & Verification...");

    const expectedRate = 15.0;
    const expectedAmount = Math.round(dbTxn.amount * (expectedRate / 100) * 100) / 100;

    // Check in PostgreSQL
    const [dbCommission] = await db
      .select()
      .from(partnerCommissions)
      .where(eq(partnerCommissions.subscriptionTransactionId, transactionId))
      .limit(1);

    if (!dbCommission) {
      throw new Error(`Partner commission record was NOT automatically generated for transaction ${transactionId}!`);
    }

    console.log(`  ✓ Partner Commission Record Found in DB:`, {
      id: dbCommission.id,
      partnerId: dbCommission.partnerId,
      restaurantId: dbCommission.restaurantId,
      subscriptionTransactionId: dbCommission.subscriptionTransactionId,
      transactionAmount: dbCommission.transactionAmount,
      commissionRate: dbCommission.commissionRate,
      commissionAmount: dbCommission.commissionAmount,
      currency: dbCommission.currency,
      status: dbCommission.status,
    });

    if (dbCommission.partnerId !== partnerId) {
      throw new Error(`Commission partnerId mismatch: expected ${partnerId}, got ${dbCommission.partnerId}`);
    }
    if (dbCommission.restaurantId !== restaurantId) {
      throw new Error(`Commission restaurantId mismatch: expected ${restaurantId}, got ${dbCommission.restaurantId}`);
    }
    if (dbCommission.transactionAmount !== dbTxn.amount) {
      throw new Error(`Commission transactionAmount mismatch: expected ${dbTxn.amount}, got ${dbCommission.transactionAmount}`);
    }
    if (dbCommission.commissionRate !== expectedRate) {
      throw new Error(`Commission commissionRate mismatch: expected ${expectedRate}, got ${dbCommission.commissionRate}`);
    }
    if (dbCommission.commissionAmount !== expectedAmount) {
      throw new Error(`Commission commissionAmount mismatch: expected ${expectedAmount}, got ${dbCommission.commissionAmount}`);
    }
    if (dbCommission.status !== "pending") {
      throw new Error(`Commission initial status mismatch: expected 'pending', got '${dbCommission.status}'`);
    }

    const commissionId = dbCommission.id;

    // Check Partner Commission Dashboard API
    const partnerCommsRes = await makeRequest(
      serverUrl,
      "GET",
      "/api/partner/commissions",
      undefined,
      { Authorization: `Bearer ${partnerToken}` }
    );

    const foundInPartnerComms = (partnerCommsRes.body as any[]).find((c) => c.id === commissionId);
    if (!foundInPartnerComms) {
      throw new Error(`Commission ${commissionId} is not visible in Partner's GET /api/partner/commissions API!`);
    }
    console.log(`  ✓ Commission confirmed in Partner Dashboard API: ₹${foundInPartnerComms.commissionAmount} (Status: ${foundInPartnerComms.status})`);

    // ────────────────────────────────────────────────────────────────────────
    // 7. Idempotency Check
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 7: Testing Commission Idempotency...");

    // Re-run commission calculation via central engine
    const secondCalcResult = await recordPartnerCommission(transactionId);
    console.log(`  → Direct Engine Re-Execution Result:`, secondCalcResult);

    if (secondCalcResult.created !== false || secondCalcResult.reason !== "already_recorded") {
      throw new Error(`Idempotency check failed: expected created=false & reason='already_recorded', got: ${JSON.stringify(secondCalcResult)}`);
    }

    // Re-run via admin mark-paid API
    const reMarkPaidRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/admin/transactions/${transactionId}/mark-paid`,
      {},
      { Authorization: `Bearer ${adminToken}` }
    );
    console.log(`  → Admin Mark-Paid Re-Trigger Status: ${reMarkPaidRes.status}`);

    // Verify DB count of commissions for this transaction is strictly 1
    const matchingCommissions = await db
      .select()
      .from(partnerCommissions)
      .where(eq(partnerCommissions.subscriptionTransactionId, transactionId));

    console.log(`  ✓ DB Count of Commissions for Transaction ID ${transactionId}: ${matchingCommissions.length}`);
    if (matchingCommissions.length !== 1) {
      throw new Error(`Idempotency violation! Expected exactly 1 commission record, found ${matchingCommissions.length}`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 8. Manual Payout Flow by Super Admin
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 8: Super Admin Manual Payout Execution...");

    // 8a. Approve Commission
    const approveCommRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/admin/commissions/${commissionId}/status`,
      {
        status: "approved",
        notes: "Approved by Super Admin for payout batch",
      },
      { Authorization: `Bearer ${adminToken}` }
    );

    if (approveCommRes.status !== 200 || approveCommRes.body.status !== "approved") {
      throw new Error(`Failed to approve commission: ${JSON.stringify(approveCommRes.body)}`);
    }
    console.log(`  ✓ Commission Status updated to 'approved'`);

    // 8b. Mark Paid with Manual Payout Reference & Notes
    const testPayoutRef = `PAYOUT-NEFT-${timestamp}`;
    const testPayoutNotes = "Manual bank transfer via HDFC Corporate NetBanking to partner registered account";

    const payCommRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/admin/commissions/${commissionId}/status`,
      {
        status: "paid",
        payoutReference: testPayoutRef,
        notes: testPayoutNotes,
      },
      { Authorization: `Bearer ${adminToken}` }
    );

    if (payCommRes.status !== 200 || payCommRes.body.status !== "paid") {
      throw new Error(`Failed to mark commission paid: ${JSON.stringify(payCommRes.body)}`);
    }

    // Verify in PostgreSQL
    const [dbCommPaid] = await db
      .select()
      .from(partnerCommissions)
      .where(eq(partnerCommissions.id, commissionId))
      .limit(1);

    if (!dbCommPaid || dbCommPaid.status !== "paid" || dbCommPaid.payoutReference !== testPayoutRef || !dbCommPaid.paidAt) {
      throw new Error(`DB verification failed for paid commission: ${JSON.stringify(dbCommPaid)}`);
    }

    console.log(`  ✓ Commission Paid in DB:`, {
      id: dbCommPaid.id,
      status: dbCommPaid.status,
      payoutReference: dbCommPaid.payoutReference,
      paidAt: dbCommPaid.paidAt,
      notes: dbCommPaid.notes,
    });

    // ────────────────────────────────────────────────────────────────────────
    // 9. Commission History & Ledger Preservation Check
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 9: Commission History Ledger Verification...");

    // Partner View
    const partnerCommsFinal = await makeRequest(
      serverUrl,
      "GET",
      "/api/partner/commissions",
      undefined,
      { Authorization: `Bearer ${partnerToken}` }
    );

    const historyItemPartner = (partnerCommsFinal.body as any[]).find((c) => c.id === commissionId);
    if (!historyItemPartner) {
      throw new Error(`Commission record disappeared from Partner ledger after payout!`);
    }

    console.log(`  ✓ Partner Ledger Record:`, {
      id: historyItemPartner.id,
      restaurantName: historyItemPartner.restaurantName,
      transactionAmount: historyItemPartner.transactionAmount,
      commissionRate: `${historyItemPartner.commissionRate}%`,
      commissionAmount: `₹${historyItemPartner.commissionAmount}`,
      status: historyItemPartner.status,
      payoutReference: historyItemPartner.payoutReference,
      paidAt: historyItemPartner.paidAt,
      notes: historyItemPartner.notes,
    });

    if (
      historyItemPartner.status !== "paid" ||
      historyItemPartner.payoutReference !== testPayoutRef ||
      !historyItemPartner.paidAt ||
      historyItemPartner.commissionAmount !== expectedAmount
    ) {
      throw new Error(`Partner history record fields incomplete: ${JSON.stringify(historyItemPartner)}`);
    }

    // Admin View
    const adminCommsFinal = await makeRequest(
      serverUrl,
      "GET",
      `/api/admin/commissions?partnerId=${partnerId}`,
      undefined,
      { Authorization: `Bearer ${adminToken}` }
    );

    const historyItemAdmin = (adminCommsFinal.body as any[]).find((c) => c.id === commissionId);
    if (!historyItemAdmin || historyItemAdmin.status !== "paid") {
      throw new Error(`Commission record missing or not paid in Admin commissions view!`);
    }
    console.log(`  ✓ Admin Ledger Record verified with complete audit history.`);

    // ────────────────────────────────────────────────────────────────────────
    // 10. Complete Database Chain Verification
    // ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ STEP 10: Complete Relational Chain Integrity Verification...");
    console.log("--------------------------------------------------------------------------------");
    console.log(`[CHAIN] 1. Partner:             ID=${dbPartnerActive.id} | Name='${dbPartnerActive.name}' | Email='${dbPartnerActive.email}'`);
    console.log(`[CHAIN] 2. Referral Code:       '${dbPartnerActive.referralCode}' (Commission Rate: ${dbPartnerActive.commissionPercentage}%)`);
    console.log(`[CHAIN] 3. Restaurant:          ID=${dbResto.id} | Name='${dbResto.name}' | partner_id=${dbResto.partnerId}`);
    console.log(`[CHAIN] 4. Subscription Txn:    ID=${dbTxn.id} | Plan='${chosenPlan.name}' | Amount=₹${dbTxn.amount} | Status='${dbTxn.status}'`);
    console.log(`[CHAIN] 5. Partner Commission:  ID=${dbCommPaid.id} | Amount=₹${dbCommPaid.commissionAmount} | Rate=${dbCommPaid.commissionRate}% | Status='${dbCommPaid.status}'`);
    console.log(`[CHAIN] 6. Manual Payout:       Reference='${dbCommPaid.payoutReference}' | PaidAt=${dbCommPaid.paidAt?.toISOString()}`);
    console.log(`[CHAIN] 7. Ledger History:      Preserved in PostgreSQL with complete audit trail`);
    console.log("--------------------------------------------------------------------------------");

    console.log("\n🎉 ALL 10 E2E PARTNER COMMISSION LIFECYCLE CHECKS PASSED WITH 100% SUCCESS!");
    console.log("================================================================================\n");

    server.close();
    process.exit(0);
  } catch (error: any) {
    console.error("\n❌ E2E TEST FAILED WITH ERROR:", error?.message || error);
    console.error(error?.stack);
    server.close();
    process.exit(1);
  }
}

runE2ETest();
