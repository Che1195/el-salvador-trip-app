/** Shown instead of any trip data when this environment is missing its secrets or its store. */
export function SetupNotice() {
  return (
    <main className="flex h-dvh items-center justify-center px-6">
      <div className="max-w-sm">
        <h1 className="type-wide text-2xl">This planner is not set up yet</h1>
        <p className="mt-3 text-ash">
          Sign-in or private storage has not been connected for this environment, so nothing can be shown. No trip
          data is stored here.
        </p>
      </div>
    </main>
  );
}
