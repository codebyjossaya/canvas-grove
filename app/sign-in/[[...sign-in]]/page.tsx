import { SignIn } from "@clerk/nextjs";
import { AuthStage } from "@/components/auth/auth-stage";

export default function SignInPage() {
  return <AuthStage finishing="Signing you in…"><SignIn /></AuthStage>;
}
