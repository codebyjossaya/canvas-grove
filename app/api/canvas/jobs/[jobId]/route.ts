import { auth } from "@clerk/nextjs/server";
import { errorJson, json } from "@/lib/bridge/http";
import { bridgeStore } from "@/lib/bridge/store";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  const { jobId } = await context.params;
  const job = await bridgeStore.getJobForUser(jobId, session.userId);
  if (!job) return errorJson(new Error("Job not found"), 404);
  return json({ jobId: job.id, state: job.state, createdAt: new Date(job.createdAt).toISOString(), result: job.result });
}
