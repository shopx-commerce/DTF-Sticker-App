import { Link, useLocation } from "wouter";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Header widget: "Sign in" logged out, avatar + logout menu logged in — doesn't gate the editor itself.
export default function AccountMenu() {
  const { user, isLoading, isAuthenticated, logout, logoutPending } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  if (isLoading) return null;

  if (!isAuthenticated || !user) {
    return (
      <Link href="/login">
        <Button variant="outline" size="sm" className="text-xs">Sign in</Button>
      </Link>
    );
  }

  const initial = (user.name || user.email).charAt(0).toUpperCase();
  const isAdmin = user.role === "admin";

  const handleLogout = async () => {
    try {
      await logout();
      setLocation("/");
    } catch (error) {
      toast({ title: "Logout failed", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="w-8 h-8 rounded-full bg-slate-800 text-white text-sm font-semibold flex items-center justify-center hover:bg-slate-700 transition-colors"
          aria-label="Account menu"
        >
          {initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="truncate max-w-[220px]">{user.name || user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Admin is oversight-only — no personal "My Designs" entry point. */}
        {!isAdmin && (
          <DropdownMenuItem onClick={() => setLocation("/my-designs")}>My Designs</DropdownMenuItem>
        )}
        {isAdmin && (
          <DropdownMenuItem onClick={() => setLocation("/admin")}>Admin Dashboard</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={logoutPending} onClick={handleLogout}>
          {logoutPending ? "Logging out..." : "Log out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
