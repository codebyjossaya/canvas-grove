import { Suspense } from "react";
import { MotionPreview } from "@/components/ui/motion-preview";

// Public, fixtures-only gallery of the motion layer (see docs/MOTION.md). No auth, no network.
// ?theme=dark or ?theme=light forces a theme; every state is reachable on the page itself.
export const metadata = { title: "Motion preview" };

export default function MotionPreviewPage() {
  return <Suspense fallback={null}><MotionPreview /></Suspense>;
}
