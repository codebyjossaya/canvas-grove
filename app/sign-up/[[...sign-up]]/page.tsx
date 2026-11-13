import { SignUp } from "@clerk/nextjs";
import { AuthStage } from "@/components/auth/auth-stage";

export default function SignUpPage() {
  return <AuthStage finishing="Setting up your account…"><SignUp /></AuthStage>;
}
