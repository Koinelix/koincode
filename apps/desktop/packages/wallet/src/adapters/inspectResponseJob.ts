import { safeResponse } from "../app/requestFacts.js";
export function executeJob(job: {
  headers: Record<string, string>;
  body: Uint8Array;
  secrets: string[];
}) {
  return safeResponse(job.headers, job.body, job.secrets);
}
