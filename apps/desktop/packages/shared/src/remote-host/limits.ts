const KIB = 1024;
const MIB = KIB * KIB;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const REMOTE_HOST_PROTOCOL_VERSION = 2;
export const REMOTE_HOST_PLUGIN_ID = "remote-host@fcode-plugins-official";
export const REMOTE_HOST_MCP_COMMAND = "__fcode-remote-host-mcp";
export const REMOTE_HOST_MCP_SERVER = "koincode_remote_host";
export const REMOTE_HOST_CHANNEL = "remoteHost";
export const REMOTE_HOST_IPC_CHANNEL = "fcode:remote-host";
export const FCODE_REMOTE_HOST_BROKER_ENV_PREFIX = "FCODE_REMOTE_HOST_BROKER_";
export const FCODE_REMOTE_HOST_BROKER_SOCKET_ENV_KEY = "FCODE_REMOTE_HOST_BROKER_SOCKET";
export const FCODE_REMOTE_HOST_BROKER_TOKEN_ENV_KEY = "FCODE_REMOTE_HOST_BROKER_TOKEN";

export const REMOTE_HOST_LIMITS = Object.freeze({
  hostCount: 200,
  pageSize: 50,
  maxPageSize: 200,
  handshakeMs: MINUTE,
  keepaliveMs: 15 * SECOND,
  keepaliveFailures: 3,
  connectionIdleMs: 10 * MINUTE,
  connectionCount: 16,
  sessionAuthorizationCount: 512,
  commandMs: 2 * MINUTE,
  uploadMs: 10 * MINUTE,
  maxExecutionMs: 30 * MINUTE,
  dispatchMs: 10 * MINUTE,
  cancelWaitMs: 5 * SECOND,
  pollMs: 10 * SECOND,
  challengeMs: 5 * MINUTE,
  sourceTtlMs: 24 * HOUR,
  retentionMs: 30 * 24 * HOUR,
  perCallConcurrency: 3,
  globalConcurrency: 6,
  hostReadConcurrency: 2,
  uploadStreams: 4,
  fileBytes: 100 * MIB,
  sourceBytes: 200 * MIB,
  snapshotBytes: 1024 * MIB,
  snapshotAllocationBytes: 4096,
  snapshotEntries: 262144,
  snapshotSweepMs: 15 * MINUTE,
  fileCount: 5000,
  scannedEntries: 10000,
  directoryDepth: 32,
  textBytes: 5 * MIB,
  modelBytes: 32 * KIB,
  outputBytes: 10 * MIB,
  ipcBytes: 6 * MIB,
  privateKeyBytes: MIB,
  pathBytes: 4096,
  busyTimeoutMs: 2500,
  schemaVersion: 2,
});

export const REMOTE_HOST_TOOLS = [
  "get_remote_context", "list_directory", "read_file", "write_file",
  "upload", "exec", "get_execution", "cancel_execution",
] as const;
