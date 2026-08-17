import { useEffect, useState } from "react";
import { useSearch, Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { getErrorMessage } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth-layout";
import { Button } from "@/components/ui/button";

type Status = "verifying" | "success" | "error";

export default function VerifyEmailPage() {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") || "";
  const [status, setStatus] = useState<Status>("verifying");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!token) {
        setStatus("error");
        setMessage("Missing verification token.");
        return;
      }
      try {
        const res = await apiRequest("GET", `/api/auth/verify?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!cancelled) {
          setStatus("success");
          setMessage(data.message || "Email verified.");
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setMessage(getErrorMessage(error, "This verification link is invalid or has expired."));
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const title =
    status === "verifying" ? "Verifying..." : status === "success" ? "Email verified" : "Verification failed";

  return (
    <AuthLayout title={title}>
      <p className="text-sm text-slate-600 mb-6">
        {status === "verifying" ? "Hang tight, confirming your email address." : message}
      </p>
      {status !== "verifying" && (
        <Link href="/login">
          <Button className="w-full">Go to login</Button>
        </Link>
      )}
    </AuthLayout>
  );
}
