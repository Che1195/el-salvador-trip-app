import { redirect } from "next/navigation";
import { getDeps } from "@/server/deps";
import { getTripSnapshot } from "@/server/operations";
import { getPageSession } from "@/server/page-session";
import { SetupNotice } from "@/ui/SetupNotice";
import { Workspace } from "@/ui/Workspace";

// Rendered per request, after the session check. Trip data never reaches the
// build output or a shared cache.
export const dynamic = "force-dynamic";

export default async function TripPage() {
  const deps = await getDeps();
  const page = await getPageSession(deps);
  if (page.state === "unavailable") return <SetupNotice />;
  if (page.state !== "ok") redirect("/login");

  const { session } = page;
  const snapshot = await getTripSnapshot({
    principal: session.principal,
    tripId: deps.config.tripId,
    store: session.store,
    now: deps.clock(),
  });

  return (
    <Workspace
      initial={snapshot}
      signedInAs={session.principal.label}
      fixturePasswordInUse={session.auth.fixture}
    />
  );
}
