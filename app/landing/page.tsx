import { Landing } from "@/components/ui/landing";

// Signed-out visitors to "/" are rewritten here by proxy.ts, so the public page renders
// without the workspace chrome while the URL stays "/".
export default function LandingPage() {
  return <Landing/>;
}
