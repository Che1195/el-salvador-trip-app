import { getDeps } from "@/server/deps";
import { handleMcpRequest } from "@/server/mcp/handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request, await getDeps());
}

export async function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request, await getDeps());
}

export async function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request, await getDeps());
}
