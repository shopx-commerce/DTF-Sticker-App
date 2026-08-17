import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useLocation, useSearch } from "wouter";
import { passwordSchema } from "@shared/schema";
import { withConfirmPassword } from "@/lib/password-confirmation";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth-layout";
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";

const formSchema = withConfirmPassword(z.object({ password: passwordSchema }));
type FormValues = z.infer<typeof formSchema>;

export default function ResetPasswordPage() {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") || "";
  const { resetPassword } = useAuth();
  const [, setLocation] = useLocation();
  const [done, setDone] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      await resetPassword({ token, password: values.password });
      setDone(true);
    } catch (error) {
      form.setError("root", { message: getErrorMessage(error) });
    }
  };

  if (done) {
    return (
      <AuthLayout title="Password updated" description="You can now log in with your new password.">
        <Button className="w-full" onClick={() => setLocation("/login")}>Go to login</Button>
      </AuthLayout>
    );
  }

  if (!token) {
    return (
      <AuthLayout title="Invalid link" description="This password reset link is missing or malformed.">
        <Link href="/forgot-password">
          <Button className="w-full">Request a new link</Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set a new password">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl><PasswordInput {...field} /></FormControl>
                <FormDescription className="text-xs">
                  At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a special character.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm password</FormLabel>
                <FormControl><PasswordInput {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {form.formState.errors.root && (
            <p className="text-sm font-medium text-destructive">{form.formState.errors.root.message}</p>
          )}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Updating..." : "Update password"}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  );
}
