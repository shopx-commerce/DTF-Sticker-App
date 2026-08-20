import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import StickerMaker from "@/pages/sticker-maker";
import EmbedPage from "@/pages/embed";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import VerifyEmailPage from "@/pages/verify-email";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import { useSessionExpiredToast } from "@/hooks/use-auth";

function Router() {
  return (
    <Switch>
      <Route path="/" component={StickerMaker} />
      <Route path="/embed" component={EmbedPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function SessionWatcher() {
  useSessionExpiredToast();
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <SessionWatcher />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
