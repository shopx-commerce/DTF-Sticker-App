import { apiRequest } from "@/lib/queryClient";
import type { GangSheet } from "@shared/schema";

// Persists a finished gang sheet PDF (+ optional thumbnail) — never the live editable layout.

// Derived from GangSheet; date columns overridden to string since they cross the wire as JSON.
export type SavedGangSheet = Omit<GangSheet, "createdAt" | "deletedAt"> & {
  createdAt: string;
  deletedAt: string | null;
};

export async function saveGangSheet(params: {
  name: string;
  pdfBlob: Blob;
  thumbnailBlob?: Blob | null;
  sheetWidth: number;
  sheetHeight: number;
  itemCount: number;
  totalQuantity: number;
}): Promise<SavedGangSheet> {
  const form = new FormData();
  form.append("pdf", params.pdfBlob, "gang_sheet.pdf");
  if (params.thumbnailBlob) {
    form.append("thumbnail", params.thumbnailBlob, "thumbnail.png");
  }
  form.append("name", params.name);
  form.append("sheetWidth", String(params.sheetWidth));
  form.append("sheetHeight", String(params.sheetHeight));
  form.append("itemCount", String(params.itemCount));
  form.append("totalQuantity", String(params.totalQuantity));

  const res = await apiRequest("POST", "/api/gang-sheets", form);
  const data = await res.json();
  return data.gangSheet as SavedGangSheet;
}

// Re-download via the same-origin /:id/file proxy (not R2 directly — CORS) then triggers a save.
export async function downloadAssetFile(assetId: number, filename: string): Promise<void> {
  const res = await apiRequest("GET", `/api/assets/${assetId}/file`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}
