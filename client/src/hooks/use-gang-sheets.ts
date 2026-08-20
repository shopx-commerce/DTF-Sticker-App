import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { saveGangSheet, type SavedGangSheet } from "@/lib/gang-sheet-document";

const GANG_SHEETS_KEY = ["/api/gang-sheets"] as const;

export function useGangSheetList() {
  return useQuery<{ gangSheets: SavedGangSheet[] } | null>({
    queryKey: GANG_SHEETS_KEY,
    queryFn: getQueryFn<{ gangSheets: SavedGangSheet[] } | null>({ on401: "returnNull" }),
  });
}

export function useSaveGangSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveGangSheet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GANG_SHEETS_KEY }),
  });
}

export function useDeleteGangSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/gang-sheets/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GANG_SHEETS_KEY }),
  });
}
