import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import AccountMenu from "@/components/account-menu";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import { useAdminStats, useAdminUsers, useAdminDesigns, useForkDesign } from "@/hooks/use-admin";
import { getAssetUrl } from "@/lib/design-document";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";

function DesignThumb({ assetId, name }: { assetId: number | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!assetId) return;
    getAssetUrl(assetId).then((u) => { if (!cancelled) setUrl(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [assetId]);

  return (
    <div className="w-12 h-12 rounded bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
      {url ? <img src={url} alt={name} className="w-full h-full object-contain" /> : <div className="w-4 h-4 rounded bg-slate-200" />}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200/60 p-5">
      <p className="text-xs text-slate-500 font-medium">{label}</p>
      <p className="text-3xl font-bold text-slate-900 mt-1">{value}</p>
    </div>
  );
}

export default function AdminPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const { data: statsData, isLoading: statsLoading } = useAdminStats();
  const { data: usersData, isLoading: usersLoading } = useAdminUsers();
  const { data: designsData, isLoading: designsLoading } = useAdminDesigns();
  const forkDesign = useForkDesign();
  const [ownerFilter, setOwnerFilter] = useState("");

  // UX guard only — every /api/admin/* route is independently gated by requireAdmin server-side.
  useEffect(() => {
    if (!authLoading && (!user || !isAdmin)) setLocation("/");
  }, [authLoading, user, isAdmin, setLocation]);

  // Opens the real editor in read-only mode against the owner's actual files — not a fork.
  const handleView = (designId: number) => setLocation(`/?adminView=${designId}`);

  const handleEditAsOwn = async (designId: number) => {
    try {
      const result = await forkDesign.mutateAsync({ id: designId });
      toast({
        title: result.reused ? "Reopening your copy" : "Copied to your account",
        description: `Opening "${result.design.name}"…`,
      });
      setLocation(`/?design=${result.design.id}`);
    } catch (error) {
      toast({ title: "Couldn't copy design", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  if (authLoading || !user || !isAdmin) return null;

  const users = usersData?.users ?? [];
  const designs = (designsData?.designs ?? []).filter((d) =>
    ownerFilter.trim() ? d.ownerEmail.toLowerCase().includes(ownerFilter.trim().toLowerCase()) : true
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <header className="bg-white/95 backdrop-blur-md border-b border-slate-200/60 px-6 py-3.5 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-sm text-slate-600 hover:text-slate-900">&larr; Back to editor</Link>
          <h1 className="text-lg font-semibold text-slate-900">Admin Dashboard</h1>
          <div className="w-24 flex justify-end"><AccountMenu /></div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Total Users" value={statsLoading ? "…" : statsData?.stats.totalUsers ?? 0} />
          <StatCard label="Total Designs" value={statsLoading ? "…" : statsData?.stats.totalDesigns ?? 0} />
          <StatCard label="Total Downloads" value={statsLoading ? "…" : statsData?.stats.totalDownloads ?? 0} />
        </div>

        <section className="bg-white rounded-xl shadow-sm border border-slate-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-900">Users</h2>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Designs</TableHead>
                  <TableHead className="text-right">Downloads</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-slate-400">Loading…</TableCell></TableRow>
                ) : users.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-slate-400">No users yet.</TableCell></TableRow>
                ) : (
                  users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.email}</TableCell>
                      <TableCell>{u.name || "—"}</TableCell>
                      <TableCell>
                        {u.emailVerified ? (
                          <Badge variant="secondary">Verified</Badge>
                        ) : (
                          <Badge variant="outline">Unverified</Badge>
                        )}
                      </TableCell>
                      <TableCell>{u.role}</TableCell>
                      <TableCell className="text-right">{u.designCount}</TableCell>
                      <TableCell className="text-right">{u.downloadCount}</TableCell>
                      <TableCell className="text-slate-500 text-sm">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-sm border border-slate-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-4">
            <h2 className="font-semibold text-slate-900">All Designs</h2>
            <input
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              placeholder="Filter by owner email…"
              className="text-sm border border-slate-200 rounded-md px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-slate-300"
            />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {designsLoading ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-slate-400">Loading…</TableCell></TableRow>
                ) : designs.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-slate-400">No designs found.</TableCell></TableRow>
                ) : (
                  designs.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell><DesignThumb assetId={d.thumbnailAssetId} name={d.name} /></TableCell>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell className="text-slate-500">{d.ownerEmail}</TableCell>
                      <TableCell className="text-slate-500 text-sm">{new Date(d.updatedAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button size="sm" variant="ghost" onClick={() => handleView(d.id)}>View</Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={forkDesign.isPending}
                          onClick={() => handleEditAsOwn(d.id)}
                        >
                          Edit as my own
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </main>
    </div>
  );
}
