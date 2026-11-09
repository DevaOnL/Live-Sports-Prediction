"use client";
export default function WorkspaceError({ reset }: { reset: () => void }) { return <section className="state-panel" role="alert"><h1>This view could not be opened.</h1><p>Please try again. Your saved data has not been changed.</p><button className="button" onClick={reset}>Try again</button></section>; }
