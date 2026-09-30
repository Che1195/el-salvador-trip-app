import { getDeps } from "@/server/deps";
import { handleLogin } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleLogin(request, await getDeps());
}
