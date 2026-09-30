import { getDeps } from "@/server/deps";
import { handleHealth } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleHealth(request, await getDeps());
}
