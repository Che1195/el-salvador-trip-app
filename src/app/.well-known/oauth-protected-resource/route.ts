import { getDeps } from "@/server/deps";
import { handleProtectedResourceMetadata } from "@/server/oauth/metadata";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleProtectedResourceMetadata(request, await getDeps());
}
