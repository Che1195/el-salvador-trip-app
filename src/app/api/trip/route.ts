import { getDeps } from "@/server/deps";
import { handleGetTrip } from "@/server/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleGetTrip(request, await getDeps());
}
