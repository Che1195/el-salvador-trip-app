import { getDeps } from "@/server/deps";
import { handleLogout } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleLogout(request, await getDeps());
}
