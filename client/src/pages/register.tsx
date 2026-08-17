import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useLocation } from "wouter";
import { registerSchema } from "@shared/schema";
import { withConfirmPassword } from "@/lib/password-confirmation";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth-layout";
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";

// Same rules as the server's registerSchema, but `name` allows an empty string (optional).
const formSchema = withConfirmPassword(
  registerSchema.extend({
    name: z.string().trim().max(200).optional().or(z.literal("")),
  })
);
type FormValues = z.infer<typeof formSchema>;

export default function RegisterPage() {
  const { register: registerUser } = useAuth();
  const [, setLocation] = useLocation();
  // Shown as-is — the exact wording depends on whether email verification is currently required.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", password: "", confirmPassword: "", name: "" },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const result = await registerUser({
        email: values.email,
        password: values.password,
        name: values.name || undefined,
      });
      setSuccessMessage(result.message);
    } catch (error) {
      form.setError("root", { message: getErrorMessage(error) });
    }
  };

  if (successMessage) {
    return (
      <AuthLayout title="Account created" description={successMessage}>
        <Button className="w-full" onClick={() => setLocation("/login")}>Go to login</Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create an account"
      description="Save designs, track downloads, and pick up where you left off."
      footer={
        <span>
          Already have an account?{" "}
          <Link href="/login" className="text-slate-200 hover:text-white font-medium underline">Log in</Link>
        </span>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name (optional)</FormLabel>
                <FormControl><Input placeholder="Jane Doe" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
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
                <FormLabel>Password</FormLabel>
                <FormControl><PasswordInput placeholder="At least 8 characters" {...field} /></FormControl>
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
            {form.formState.isSubmitting ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  );
}
