// Compatibility exports for callers migrating to the source-independent hook.
export {
  useSessionMigration as useClaudeSessionMigration,
  UNLIMITED_SCAN_LIMIT_INPUT,
} from "./useSessionMigration.js";
export type {
  SessionMigrationRange as ClaudeMigrationRange,
  SessionMigrationSupportState as ClaudeSessionMigrationSupportState,
} from "./useSessionMigration.js";
