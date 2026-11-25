import { ensureDbReady } from "@workspace/db";

let bootPromise: Promise<void> | null = null;

export function setStartupBootPromise(promise: Promise<void>): void {
  bootPromise = promise;
}

export async function waitForStartupReady(): Promise<void> {
  if (bootPromise) {
    await bootPromise;
    return;
  }
  await ensureDbReady();
}
