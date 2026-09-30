import { getDeps } from "@/server/deps";
import { handleActivity } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleActivity(request, await getDeps());
}
