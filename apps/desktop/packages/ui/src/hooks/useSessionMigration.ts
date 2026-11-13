import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FCodeImportSessionsResult,
  FCodeImportableSessionCandidate,
  FCodeImportSessionSourceProvider,
  FCodeSessionImportDiagnostic,
} from "@fcode/shared";
import { useFCodeTaskService } from "@/hooks/useFCodeTaskService.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

export type SessionMigrationRange = "all" | "7d" | "30d" | "90d";
export interface SessionMigrationSupportState {
  supported: boolean;
  reason?: "desktopOnly";
}
export const UNLIMITED_SCAN_LIMIT_INPUT = "unlimited";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

export function useSessionMigration(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  // Read this desktop user's files even when a remote workspace tab is active.
  const service = useFCodeTaskService();
  const tabStoreApi = useTabStoreApi();
  const [source, setSourceState] = useState<FCodeImportSessionSourceProvider>("claude");
  const [workspaceFilterMode, setWorkspaceFilterModeState] = useState<"all" | "current">("all");
  const [range, setRangeState] = useState<SessionMigrationRange>("30d");
  const [limitInput, setLimitInputState] = useState(String(DEFAULT_LIMIT));
  const [rawCandidates, setCandidates] = useState<FCodeImportableSessionCandidate[]>([]);
  const [diagnostics, setDiagnostics] = useState<FCodeSessionImportDiagnostic[]>([]);
  const [targetWorkspacePaths, setTargetWorkspacePaths] = useState<Record<string, string>>({});
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] = useState<FCodeImportSessionsResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const generation = useRef(0);
  const importRunning = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const reset = useCallback(() => {
    generation.current += 1;
    setCandidates([]);
    setDiagnostics([]);
    setTargetWorkspacePaths({});
    setSelectedSessionIds([]);
    setScanError(null);
    setImportError(null);
    setLastImportResult(null);
    setIsScanning(false);
  }, []);
  const setSource = useCallback(
    (value: FCodeImportSessionSourceProvider) => {
      if (importRunning.current || value === source) return;
      reset();
      setSourceState(value);
    },
    [reset, source],
  );
  const setRange = useCallback(
    (value: SessionMigrationRange) => {
      if (importRunning.current) return;
      reset();
      setRangeState(value);
    },
    [reset],
  );
  const setLimitInput = useCallback(
    (value: string) => {
      if (importRunning.current) return;
      reset();
      setLimitInputState(value);
    },
    [reset],
  );
  const setWorkspaceFilterMode = useCallback(
    (value: "all" | "current") => {
      if (importRunning.current) return;
      reset();
      setWorkspaceFilterModeState(value === "current" && !params.workspacePath ? "all" : value);
    },
    [params.workspacePath, reset],
  );
  const workspacePath =
    workspaceFilterMode === "current" ? (params.workspacePath ?? undefined) : undefined;
  const workspaceIdentity = workspacePath ? params.workspaceIdentity : undefined;
  const parsedLimit = Number.parseInt(limitInput, 10);
  const scanLimit =
    limitInput === UNLIMITED_SCAN_LIMIT_INPUT
      ? undefined
      : Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(MAX_LIMIT, parsedLimit)
        : DEFAULT_LIMIT;
  const supportState = useMemo<SessionMigrationSupportState>(
    () => (params.isDesktop ? { supported: true } : { supported: false, reason: "desktopOnly" }),
    [params.isDesktop],
  );
  const candidates = useMemo(
    () =>
      rawCandidates.map((candidate) =>
        targetWorkspacePaths[candidate.sessionId]
          ? { ...candidate, workspacePath: targetWorkspacePaths[candidate.sessionId]! }
          : candidate,
      ),
    [rawCandidates, targetWorkspacePaths],
  );
  const scan = useCallback(async () => {
    if (!supportState.supported || importRunning.current) return;
    const requestGeneration = ++generation.current;
    setIsScanning(true);
    setScanError(null);
    try {
      const result = await service.scanImportableSessions({
        source,
        workspacePath,
        workspaceIdentity,
        modifiedSince: range === "all" ? undefined : Date.now() - RANGE_DAYS[range] * 86400000,
        ...(scanLimit === undefined ? {} : { limit: scanLimit }),
      });
      if (generation.current !== requestGeneration) return;
      const next = result.candidates.filter((candidate) => candidate.provider === source);
      setCandidates(next);
      setDiagnostics(result.diagnostics);
      setSelectedSessionIds((previous) =>
        previous.filter((id) => next.some((candidate) => candidate.sessionId === id)),
      );
    } catch (error) {
      if (generation.current === requestGeneration)
        setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === requestGeneration) setIsScanning(false);
    }
  }, [service, source, workspacePath, workspaceIdentity, range, scanLimit, supportState.supported]);

  const importSessions = useCallback(
    async (sessionIds: string[]) => {
      if (!supportState.supported || !sessionIds.length || importRunning.current) return null;
      importRunning.current = true;
      setIsImporting(true);
      setImportError(null);
      const requestGeneration = generation.current;
      try {
        const result = await service.importSessions({
          source,
          workspacePath,
          workspaceIdentity,
          sessionIds,
          targetWorkspacePaths,
        });
        if (result.imported.length) {
          for (const path of new Set(result.imported.map((item) => item.workspacePath)))
            tabStoreApi.getState().ensureWorkspaceTab(path);
          invalidateTaskQueryCacheByScopes(
            result.imported.map((item) => ({ workspacePath: item.workspacePath })),
          );
        }
        if (generation.current === requestGeneration) {
          setLastImportResult(result);
          const imported = new Set(result.imported.map((item) => item.sessionId));
          setSelectedSessionIds((previous) => previous.filter((id) => !imported.has(id)));
        }
        return result;
      } catch (error) {
        if (generation.current === requestGeneration)
          setImportError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        importRunning.current = false;
        setIsImporting(false);
      }
    },
    [
      service,
      source,
      workspacePath,
      workspaceIdentity,
      supportState.supported,
      tabStoreApi,
      targetWorkspacePaths,
    ],
  );
  const importSelectedSessions = useCallback(
    () => importSessions(selectedSessionIds),
    [importSessions, selectedSessionIds],
  );
  const toggleSessionSelection = useCallback(
    (id: string) =>
      setSelectedSessionIds((previous) =>
        previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
      ),
    [],
  );
  const selectAllSessions = useCallback(
    () =>
      setSelectedSessionIds(
        candidates.filter((item) => item.workspacePath).map((item) => item.sessionId),
      ),
    [candidates],
  );
  const clearSelectedSessions = useCallback(() => setSelectedSessionIds([]), []);
  const setTargetWorkspacePath = useCallback(
    (sessionId: string, path: string) =>
      setTargetWorkspacePaths((previous) => ({ ...previous, [sessionId]: path })),
    [],
  );
  return {
    source,
    setSource,
    reset,
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter: params.workspacePath !== null,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    diagnostics,
    selectedSessionIds,
    selectedCount: selectedSessionIds.length,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSessions,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
    setTargetWorkspacePath,
  };
}
