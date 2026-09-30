import { getDeps } from "@/server/deps";
import { handleLogoutEverywhere } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleLogoutEverywhere(request, await getDeps());
}
