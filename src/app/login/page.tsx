import { redirect } from "next/navigation";
import { LOCAL_FIXTURE_PASSWORD } from "@/server/config";
import { getDeps } from "@/server/deps";
import { getPageSession } from "@/server/page-session";
import { LoginForm } from "@/ui/LoginForm";
import { SetupNotice } from "@/ui/SetupNotice";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const deps = await getDeps();
  const page = await getPageSession(deps);
  if (page.state === "unavailable") return <SetupNotice />;
  if (page.state === "ok") redirect("/");

  const { auth, deployment } = deps.config;
  // The hint only ever appears for the local fixture password, never for a real one.
  const fixturePassword = auth.ready && auth.fixture && deployment === "local" ? LOCAL_FIXTURE_PASSWORD : null;

  return (
    <main className="flex h-dvh flex-col overflow-y-auto">
      <div className="bg-anil px-6 pb-8 pt-[max(3rem,env(safe-area-inset-top))] text-white">
        <h1 className="type-wide mx-auto max-w-sm text-4xl leading-tight">Trip planner</h1>
        <p className="mx-auto mt-2 max-w-sm opacity-85">Itinerary, packing, budget and bookings for the people going.</p>
      </div>
      <div className="mx-auto w-full max-w-sm px-6 py-8">
        <LoginForm fixturePassword={fixturePassword} />
      </div>
    </main>
  );
}
