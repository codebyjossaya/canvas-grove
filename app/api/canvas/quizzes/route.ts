import { json } from "@/lib/bridge/http";
import { getQuizHubData } from "@/lib/quizzes/service";
import { quizAuth, quizError } from "@/lib/quizzes/http";

export const instant = true;

export async function GET(request: Request) {
  try {
    const ctx = await quizAuth();
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return json(await getQuizHubData(ctx, refresh));
  } catch (error) { return quizError(error); }
}
