import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation } from "wouter";
import { loginSchema, type LoginInput } from "@shared/schema";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth-layout";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: LoginInput) => {
    try {
      await login(values);
      setLocation("/");
    } catch (error) {
      // Shown inline below the fields, not as a toast.
      form.setError("root", { message: getErrorMessage(error) });
    }
  };

  return (
    <AuthLayout
      title="Log in"
      description="Welcome back — pick up your saved designs."
      footer={
        <span>
          Don&rsquo;t have an account?{" "}
          <Link href="/register" className="text-slate-200 hover:text-white font-medium underline">Create one</Link>
        </span>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl><Input type="email" placeholder="you@example.com" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel>Password</FormLabel>
                  <Link href="/forgot-password" className="text-xs text-slate-500 hover:text-slate-800 underline">
                    Forgot password?
                  </Link>
                </div>
                <FormControl><PasswordInput {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {form.formState.errors.root && (
            <p className="text-sm font-medium text-destructive">{form.formState.errors.root.message}</p>
          )}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Logging in..." : "Log in"}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  );
}
