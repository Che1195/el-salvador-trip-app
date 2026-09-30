import { getDeps } from "@/server/deps";
import { handleOperation } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleOperation(request, await getDeps());
}
