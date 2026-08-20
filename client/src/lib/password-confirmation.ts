import { z } from "zod";

// Adds a `confirmPassword` field + a "passwords must match" refine — shared
// by register/reset-password forms so that rule only exists in one place.
export function withConfirmPassword<Shape extends { password: z.ZodTypeAny }>(
  schema: z.ZodObject<Shape>
) {
  return schema
    .extend({ confirmPassword: z.string().min(1, "Confirm your password") })
    .refine((data) => data.password === data.confirmPassword, {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    });
}
