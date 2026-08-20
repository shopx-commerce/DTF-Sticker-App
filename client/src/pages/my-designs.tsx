import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ImageIcon, LayoutGrid, Loader2, Trash2 } from "lucide-react";
import AccountMenu from "@/components/account-menu";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import { useDesignList, useDesignMutations, type DesignSummary } from "@/hooks/use-designs";
import { useGangSheetList, useDeleteGangSheet } from "@/hooks/use-gang-sheets";
import { getAssetUrl } from "@/lib/design-document";
import { apiRequest } from "@/lib/queryClient";
import { downloadAssetFile, type SavedGangSheet } from "@/lib/gang-sheet-document";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function AssetThumbnail({ assetId, name }: { assetId: number | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!assetId) return;
    getAssetUrl(assetId)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { /* thumbnail is cosmetic — a blank tile is fine if it fails */ });
    return () => { cancelled = true; };
  }, [assetId]);

  return (
    <div className="aspect-square bg-slate-100 rounded-lg overflow-hidden flex items-center justify-center">
      {url ? (
        <img src={url} alt={name} className="w-full h-full object-contain" />
      ) : (
        <div className="w-8 h-8 rounded bg-slate-200" />
      )}
    </div>
  );
}

// Shared "nothing here yet" layout so Designs and Gang Sheets stay visually consistent.
function EmptySection({
  icon,
  message,
  ctaLabel,
  ctaHref,
}: {
  icon: ReactNode;
  message: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <div className="flex flex-col items-center text-center py-14 px-6 rounded-xl border border-dashed border-white/10 bg-white/[0.02]">
      <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-4 text-slate-400">
        {icon}
      </div>
      <p className="text-slate-300 mb-4 max-w-sm">{message}</p>
      <Link href={ctaHref}><Button size="sm">{ctaLabel}</Button></Link>
    </div>
  );
}

export default function MyDesignsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // ─── Designs ─────────────────────────────────────────────────────────
  const { data, isLoading, refetch } = useDesignList();
  const { duplicate, remove } = useDesignMutations();
  const [renaming, setRenaming] = useState<DesignSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<DesignSummary | null>(null);

  // ─── Gang Sheets ─────────────────────────────────────────────────────
  const { data: gangSheetData, isLoading: gangSheetsLoading } = useGangSheetList();
  const deleteGangSheet = useDeleteGangSheet();
  const [deletingGangSheet, setDeletingGangSheet] = useState<SavedGangSheet | null>(null);
  const [downloadingGangSheetId, setDownloadingGangSheetId] = useState<number | null>(null);
  const [viewingGangSheetId, setViewingGangSheetId] = useState<number | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) return setLocation("/login");
    // Admin is oversight-only — redirect here too, not just hide the nav link.
    if (user.role === "admin") return setLocation("/admin");
  }, [authLoading, user, setLocation]);

  const handleOpen = (design: DesignSummary) => {
    setLocation(`/?design=${design.id}`);
  };

  const handleDuplicate = async (design: DesignSummary) => {
    try {
      const result = await duplicate.mutateAsync({ id: design.id });
      toast({ title: "Saved as new", description: `"${result.design.name}" created.` });
    } catch (error) {
      toast({ title: "Couldn't duplicate design", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast({ title: "Design deleted" });
    } catch (error) {
      toast({ title: "Couldn't delete design", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setDeleting(null);
    }
  };

  // Reuses the editor's PATCH; apiRequest (not raw fetch) so a non-2xx response actually throws.
  const handleRenameSave = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name || name === renaming.name) { setRenaming(null); return; }
    try {
      await apiRequest("PATCH", `/api/designs/${renaming.id}`, { name });
      refetch();
      setRenaming(null);
    } catch (error) {
      toast({ title: "Couldn't rename design", description: getErrorMessage(error), variant: "destructive" });
      // Input stays open on failure so the typed name isn't lost.
    }
  };

  const handleDownloadGangSheet = async (gangSheet: SavedGangSheet) => {
    setDownloadingGangSheetId(gangSheet.id);
    try {
      await downloadAssetFile(gangSheet.pdfAssetId, `${gangSheet.name}.pdf`);
    } catch (error) {
      toast({ title: "Couldn't download gang sheet", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setDownloadingGangSheetId(null);
    }
  };

  // window.open (not fetch) so R2's missing CORS headers don't block it.
  const handleViewGangSheet = async (gangSheet: SavedGangSheet) => {
    setViewingGangSheetId(gangSheet.id);
    try {
      const url = await getAssetUrl(gangSheet.pdfAssetId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast({ title: "Couldn't open gang sheet", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setViewingGangSheetId(null);
    }
  };

  const handleDeleteGangSheet = async () => {
    if (!deletingGangSheet) return;
    try {
      await deleteGangSheet.mutateAsync(deletingGangSheet.id);
      toast({ title: "Gang sheet deleted" });
    } catch (error) {
      toast({ title: "Couldn't delete gang sheet", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setDeletingGangSheet(null);
    }
  };

  // Avoids a flash of content before the redirect effect above fires.
  if (authLoading || !user || user.role === "admin") return null;

  const designs = data?.designs ?? [];
  const gangSheets = gangSheetData?.gangSheets ?? [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <header className="bg-white/95 backdrop-blur-md border-b border-slate-200/60 px-6 py-3.5 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-sm text-slate-600 hover:text-slate-900">&larr; Back to editor</Link>
          <h1 className="text-lg font-semibold text-slate-900">My Designs</h1>
          <div className="w-24 flex justify-end"><AccountMenu /></div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-10">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <ImageIcon className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Designs</h2>
            {designs.length > 0 && <span className="text-xs text-slate-500">({designs.length})</span>}
          </div>
          {isLoading ? (
            <p className="text-slate-400 text-center py-16">Loading your designs…</p>
          ) : designs.length === 0 ? (
            <EmptySection
              icon={<ImageIcon className="w-5 h-5" />}
              message="You haven't saved any designs yet."
              ctaLabel="Go make one"
              ctaHref="/"
            />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {designs.map((design) => (
                <div key={design.id} className="bg-white rounded-xl shadow-md p-3 flex flex-col gap-2">
                  <button onClick={() => handleOpen(design)} className="text-left">
                    <AssetThumbnail assetId={design.thumbnailAssetId} name={design.name} />
                  </button>
                  {renaming?.id === design.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={handleRenameSave}
                      onKeyDown={(e) => { if (e.key === "Enter") handleRenameSave(); if (e.key === "Escape") setRenaming(null); }}
                      className="h-7 text-sm"
                    />
                  ) : (
                    <button
                      className="text-sm font-medium text-slate-800 truncate text-left hover:underline"
                      title="Click to rename"
                      onClick={() => { setRenaming(design); setRenameValue(design.name); }}
                    >
                      {design.name}
                    </button>
                  )}
                  <p className="text-[11px] text-slate-400">
                    Updated {new Date(design.updatedAt).toLocaleDateString()}
                  </p>
                  <div className="flex gap-1.5 mt-1">
                    <Button size="sm" variant="outline" className="flex-1 text-xs h-7" onClick={() => handleOpen(design)}>Open</Button>
                    <Button size="sm" variant="outline" className="flex-1 text-xs h-7" onClick={() => handleDuplicate(design)} disabled={duplicate.isPending}>Duplicate</Button>
                    <Button size="sm" variant="outline" className="text-xs h-7 px-2 text-red-600 hover:text-red-700" onClick={() => setDeleting(design)}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <LayoutGrid className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Gang Sheets</h2>
            {gangSheets.length > 0 && <span className="text-xs text-slate-500">({gangSheets.length})</span>}
          </div>
          {gangSheetsLoading ? (
            <p className="text-slate-400 text-center py-16">Loading your gang sheets…</p>
          ) : gangSheets.length === 0 ? (
            <EmptySection
              icon={<LayoutGrid className="w-5 h-5" />}
              message="You haven't saved any gang sheets yet — save one from the Gang Sheet panel while editing a design."
              ctaLabel="Go to editor"
              ctaHref="/"
            />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {gangSheets.map((gangSheet) => (
                <div key={gangSheet.id} className="bg-white rounded-xl shadow-md p-3 flex flex-col gap-2">
                  <button
                    onClick={() => handleViewGangSheet(gangSheet)}
                    className="text-left"
                    title="Click to view"
                  >
                    <AssetThumbnail assetId={gangSheet.thumbnailAssetId} name={gangSheet.name} />
                  </button>
                  <p className="text-sm font-medium text-slate-800 truncate" title={gangSheet.name}>{gangSheet.name}</p>
                  <p className="text-[11px] text-slate-400">
                    {gangSheet.sheetWidth}&quot; &times; {gangSheet.sheetHeight}&quot; · {gangSheet.itemCount} design{gangSheet.itemCount === 1 ? "" : "s"} · {gangSheet.totalQuantity} sticker{gangSheet.totalQuantity === 1 ? "" : "s"}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {new Date(gangSheet.createdAt).toLocaleDateString()}
                  </p>
                  {/* Icon swap on pending state, not a longer label — keeps buttons from overflowing the card. */}
                  <div className="flex gap-1.5 mt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 min-w-0 text-xs h-7 px-1.5"
                      disabled={viewingGangSheetId === gangSheet.id}
                      onClick={() => handleViewGangSheet(gangSheet)}
                    >
                      {viewingGangSheetId === gangSheet.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "View"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 min-w-0 text-xs h-7 px-1.5"
                      disabled={downloadingGangSheetId === gangSheet.id}
                      onClick={() => handleDownloadGangSheet(gangSheet)}
                    >
                      {downloadingGangSheetId === gangSheet.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Download"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 h-7 w-7 p-0 text-red-600 hover:text-red-700"
                      title="Delete"
                      onClick={() => setDeletingGangSheet(gangSheet)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleting?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingGangSheet} onOpenChange={(open) => !open && setDeletingGangSheet(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingGangSheet?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteGangSheet} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
