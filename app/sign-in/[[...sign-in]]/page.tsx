import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthStage } from "@/components/auth/auth-stage";

// Grove ships its own light and dark themes; Dark Reader re-inverts them and breaks the Clerk card.
export const metadata: Metadata = { other: { "darkreader-lock": "true" } };

export default function SignInPage() {
  return <AuthStage finishing="Signing you in…"><SignIn /></AuthStage>;
}
