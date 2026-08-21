import { apiRequest } from "@/lib/queryClient";
import type { DownloadType } from "@shared/schema";

// Fire-and-forget, call only after a download succeeds — never throws, so a tracking failure can't surface as an error (also silently skips anonymous users, who get a 401).
export function recordDownload(params: { designId?: number; gangSheetId?: number; downloadType: DownloadType; format?: string }): void {
  apiRequest("POST", "/api/downloads", params).catch(() => {
    // Best-effort telemetry only — offline, logged out, whatever. Ignore.
  });
}
