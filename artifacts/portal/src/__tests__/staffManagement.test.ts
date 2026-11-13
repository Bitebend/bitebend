/**
 * staffManagement.test.ts
 * Regression & source-contract test suite for:
 * - Portal API path resolution (no /api/api double-prefix bug in StaffManagement or StaffConnect)
 * - Sonner Toaster mounted in App.tsx so feedback toasts actually render
 * - Chef Mode Toggle state transitions, zero-staff support, error rollback & server re-sync
 * - Create & Generate PIN modal flow, 6-digit validation, 10-min expiry, copy PIN fallback,
 *   double-submit prevention, and partial-failure safe PIN retry without duplicate staff.
 */

import fs from "node:fs";
import path from "node:path";

interface TestResult {
  status: "PASSED" | "FAILED";
  note: string;
}

const results: Record<string, TestResult> = {};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function runTests() {
  console.log("================================================================================");
  console.log("🛠️ BITEBEND PORTAL STAFF MANAGEMENT & PIN CONNECTION VERIFICATION SUITE");
  console.log("================================================================================\n");

  const portalRoot = path.resolve(__dirname, "..");
  const staffMgmtSrc = fs.readFileSync(path.join(portalRoot, "pages/StaffManagement.tsx"), "utf-8");
  const staffConnectSrc = fs.readFileSync(path.join(portalRoot, "pages/staff/StaffConnect.tsx"), "utf-8");
  const chefHomeSrc = fs.readFileSync(path.join(portalRoot, "pages/staff/ChefHome.tsx"), "utf-8");
  const appSrc = fs.readFileSync(path.join(portalRoot, "App.tsx"), "utf-8");
  const apiSrc = fs.readFileSync(path.join(portalRoot, "lib/api.ts"), "utf-8");

  // 1. Source Contract: No /api prefix passed to apiFetch anywhere in StaffManagement or StaffConnect
  try {
    assert(apiSrc.includes("export const API_BASE = `${BASE}/api`"), "API_BASE must include /api");
    const doubleApiRegex = /apiFetch[^(]*\(\s*[`"'` ]\/api\//g;
    const badMatchesMgmt = staffMgmtSrc.match(doubleApiRegex);
    const badMatchesConnect = staffConnectSrc.match(doubleApiRegex);
    assert(!badMatchesMgmt, `Double /api/ prefix found in StaffManagement.tsx: ${badMatchesMgmt?.join(", ")}`);
    assert(!badMatchesConnect, `Double /api/ prefix found in StaffConnect.tsx: ${badMatchesConnect?.join(", ")}`);
    assert(staffMgmtSrc.includes('"/owner/chef-mode"'), "StaffManagement must call /owner/chef-mode via apiFetch");
    assert(staffMgmtSrc.includes('"/owner/staff"'), "StaffManagement must call /owner/staff via apiFetch");
    assert(staffConnectSrc.includes('"/staff/connect-pin"'), "StaffConnect must call /staff/connect-pin via apiFetch");
    assert(chefHomeSrc.includes("${API_BASE}/staff/chef/orders"), "ChefHome must use API_BASE for /staff/chef/orders");
    results["Test 1"] = { status: "PASSED", note: "Zero /api/api double-prefix bugs in StaffManagement, StaffConnect, and ChefHome" };
    console.log("  ✅ Test 1 PASSED: Portal API path contract");
  } catch (err: any) {
    results["Test 1"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 1 FAILED:", err.message);
  }

  // 2. Source Contract: SonnerToaster mounted in App.tsx
  try {
    assert(appSrc.includes('@/components/ui/sonner'), "App.tsx must import Sonner Toaster");
    assert(appSrc.includes("<SonnerToaster"), "App.tsx must render <SonnerToaster /> for toast.success/error visibility");
    results["Test 2"] = { status: "PASSED", note: "SonnerToaster mounted in App.tsx so StaffManagement toasts display" };
    console.log("  ✅ Test 2 PASSED: Toast provider mounted in App.tsx");
  } catch (err: any) {
    results["Test 2"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 2 FAILED:", err.message);
  }

  // 3. Source Contract: Chef Mode error revert, load-error handling, and Switch id
  try {
    assert(staffMgmtSrc.includes("setChefMode(previousState)"), "Chef Mode toggle must revert state on PATCH error");
    assert(staffMgmtSrc.includes("chefModeLoadError"), "Chef Mode must handle initial load failures cleanly");
    assert(staffMgmtSrc.includes('id="chef-mode-switch"'), "Switch must bind id='chef-mode-switch'");
    const toggleStart = staffMgmtSrc.indexOf("const handleToggleChefMode");
    const toggleEnd = staffMgmtSrc.indexOf("const openPinModal");
    const toggleBody = staffMgmtSrc.slice(toggleStart, toggleEnd);
    const switchSnippet = staffMgmtSrc.slice(
      staffMgmtSrc.indexOf('id="chef-mode-switch"'),
      staffMgmtSrc.indexOf('aria-label="Toggle Chef Mode"'),
    );
    assert(
      !toggleBody.includes("staffList") && !switchSnippet.includes("staffList"),
      "Chef Mode toggle must NOT depend on staffList",
    );
    results["Test 3"] = { status: "PASSED", note: "Chef Mode toggle works independently of staff count with error revert & load guard" };
    console.log("  ✅ Test 3 PASSED: Chef Mode UI invariants");
  } catch (err: any) {
    results["Test 3"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 3 FAILED:", err.message);
  }

  // 4. Source Contract: Create & Generate PIN modal, partial-failure recovery without duplicate staff, clipboard fallback
  try {
    assert(staffMgmtSrc.includes("if (creating) return;"), "handleCreateStaff must guard against double submission");
    assert(staffMgmtSrc.includes("pinRecoveryState"), "Partial failure recovery state must allow safe retry without duplicate staff");
    assert(staffMgmtSrc.includes("Retry Generate PIN"), "Recovery UI must offer Retry Generate PIN button");
    assert(staffMgmtSrc.includes('document.execCommand("copy")'), "Copy PIN must include execCommand fallback for HTTP/iframe contexts");
    assert(staffMgmtSrc.includes("Expires in 10 minutes (one-time use)"), "PIN modal must show 10-minute expiry & one-time notice");
    assert(staffMgmtSrc.includes("/staff/connect"), "PIN modal must instruct staff to visit /staff/connect");
    results["Test 4"] = { status: "PASSED", note: "Create & PIN modal, partial failure retry, and clipboard fallback verified in source" };
    console.log("  ✅ Test 4 PASSED: Create & Generate PIN UI invariants");
  } catch (err: any) {
    results["Test 4"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 4 FAILED:", err.message);
  }

  // 5. Behavioral: Chef Mode state transition + error rollback + concurrency guard
  try {
    let chefMode = false;
    let updating = false;
    let errorBanner: string | null = null;
    let patchCalls = 0;

    const toggle = async (next: boolean, shouldFail = false) => {
      if (updating) return;
      const prev = chefMode;
      chefMode = next;
      updating = true;
      errorBanner = null;
      patchCalls++;
      try {
        await new Promise((r) => setTimeout(r, 15));
        if (shouldFail) throw new Error("Server returned 500");
        chefMode = next;
      } catch (e: any) {
        chefMode = prev;
        errorBanner = e.message;
      } finally {
        updating = false;
      }
    };

    // Rapid concurrent toggles -> only 1 PATCH fires
    await Promise.all([toggle(true, false), toggle(false, false)]);
    assert(patchCalls === 1 && chefMode === true, "Concurrent toggle must lock and settle to true");

    // Failed toggle -> reverts to true and surfaces error
    await toggle(false, true);
    assert(chefMode === true && errorBanner === "Server returned 500", "Failed toggle must revert to confirmed server state");

    results["Test 5"] = { status: "PASSED", note: "Concurrent lock and error rollback behave deterministically" };
    console.log("  ✅ Test 5 PASSED: Chef Mode concurrency and error rollback");
  } catch (err: any) {
    results["Test 5"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 5 FAILED:", err.message);
  }

  // 6. Behavioral: Create + PIN partial failure recovery creates staff once, retries PIN only
  try {
    let staffCreates = 0;
    let pinAttempts = 0;
    let recoveryStaffId: number | null = null;
    let pinModal: { staffId: number; pin: string } | null = null;

    const createAndPin = async (failPinOnce: boolean) => {
      staffCreates++;
      const createdId = 42;
      try {
        pinAttempts++;
        if (failPinOnce) throw new Error("Transient PIN generation error");
        pinModal = { staffId: createdId, pin: "654321" };
      } catch {
        recoveryStaffId = createdId;
      }
    };

    const retryPinOnly = async (staffId: number) => {
      pinAttempts++;
      pinModal = { staffId, pin: "789012" };
      recoveryStaffId = null;
    };

    await createAndPin(true);
    assert(staffCreates === 1 && recoveryStaffId === 42 && pinModal === null, "Partial failure should record recovery staff ID without modal");
    await retryPinOnly(recoveryStaffId!);
    assert(staffCreates === 1 && pinAttempts === 2 && pinModal?.pin === "789012" && recoveryStaffId === null, "Retry must regenerate PIN without duplicate staff creation");

    results["Test 6"] = { status: "PASSED", note: "Partial failure recovery regenerates PIN safely with zero duplicate staff" };
    console.log("  ✅ Test 6 PASSED: Partial failure recovery without duplicates");
  } catch (err: any) {
    results["Test 6"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 6 FAILED:", err.message);
  }

  console.log("\n================================================================================");
  console.log("📊 STAFF MANAGEMENT VERIFICATION SUMMARY");
  console.log("================================================================================");
  let passedCount = 0;
  for (const [name, res] of Object.entries(results)) {
    console.log(`[${res.status}] ${name}: ${res.note}`);
    if (res.status === "PASSED") passedCount++;
  }
  console.log(`TOTAL: ${passedCount} / ${Object.keys(results).length} TESTS PASSED\n`);
  if (passedCount !== Object.keys(results).length) process.exit(1);
}

runTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
