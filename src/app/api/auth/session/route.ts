import { getDeps } from "@/server/deps";
import { handleSessionInfo } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleSessionInfo(request, await getDeps());
}
