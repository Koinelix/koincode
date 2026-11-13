import type {
  FCodePersistedMessage,
  FCodeTaskPersistStatus,
  FCodeImportSessionSourceProvider,
  FCodeTaskMigrationSource,
} from "@fcode/shared";

/** 导入来源身份：外部原生 CLI（Claude Code），与 agent runtime 的 FCodeProvider 无关。 */
export type ClaudeNativeImportSourceProvider = FCodeImportSessionSourceProvider;

export interface ClaudeNativeImportedSessionSource {
  provider: ClaudeNativeImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  status?: FCodeTaskPersistStatus;
  migrationSource?: FCodeTaskMigrationSource;
  messages: FCodePersistedMessage[];
}
