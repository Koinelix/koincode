/** An opaque logical reference, never a filesystem path or an execution permission. */
export function remoteExecutionOutputArtifactId(executionId: string, attempt: number): string {
  return `output:${executionId}:${attempt}`;
}
