import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "wouter";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@shared/schema";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth-layout";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function ForgotPasswordPage() {
  const { forgotPassword } = useAuth();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: ForgotPasswordInput) => {
    try {
      await forgotPassword(values);
      setSubmitted(true);
    } catch (error) {
      form.setError("root", { message: getErrorMessage(error) });
    }
  };

  if (submitted) {
    return (
      <AuthLayout
        title="Check your email"
        description="If an account exists for that email, we've sent a link to reset your password."
      >
        <Link href="/login">
          <Button className="w-full">Back to login</Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot password"
      description="Enter your email and we'll send you a reset link."
      footer={
        <Link href="/login" className="text-slate-200 hover:text-white font-medium underline">Back to login</Link>
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
          {form.formState.errors.root && (
            <p className="text-sm font-medium text-destructive">{form.formState.errors.root.message}</p>
          )}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Sending..." : "Send reset link"}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  );
}
