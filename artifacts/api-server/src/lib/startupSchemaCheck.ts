export interface StartupSchemaCheckResult {
  ok: boolean;
  missingTables: string[];
}

export async function validateStartupRequiredTables(params: {
  fetchExistingTableNames: () => Promise<string[]>;
  requiredTables: readonly string[];
  isProduction: boolean;
  onMissingTable: (tableName: string) => void;
  onFailureMessage: (message: string) => void;
}): Promise<StartupSchemaCheckResult> {
  const existing = await params.fetchExistingTableNames();
  const found = new Set(existing);
  const missingTables = params.requiredTables.filter((t) => !found.has(t));

  if (missingTables.length > 0) {
    for (const table of missingTables) {
      params.onMissingTable(`[MIGRATION_ERROR] missing table: ${table}`);
    }
    params.onFailureMessage(
      "[MIGRATION_ERROR] DB startup check failed — tables may still be initializing or run 'pnpm migrate'",
    );
    if (params.isProduction) {
      return { ok: false, missingTables };
    }
  }

  return { ok: missingTables.length === 0, missingTables };
}
