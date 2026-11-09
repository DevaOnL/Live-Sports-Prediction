const competitions = [
  { country: "England", name: "Championship", teams: 24, tiers: "1–8 / 9–16 / 17–24" },
  { country: "France", name: "Ligue 2", teams: 18, tiers: "1–6 / 7–12 / 13–18" },
];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <a className="brand" href="#main" aria-label="Live Sports Prediction home">
          <span className="brand-mark" aria-hidden="true">lp<span /></span>
          <span>Live Sports<br />Prediction</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#coverage">Coverage</a>
          <a href="#methodology">Methodology</a>
          <a className="button button-small" href="/login">Sign in <span aria-hidden="true">→</span></a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow"><span className="status-dot" /> A considered view of football</p>
          <h1 id="hero-title">The next match.<br /><span>A clearer perspective.</span></h1>
          <p className="hero-copy">Five qualifying appearances. The opposition in context.<br className="desktop-break" /> A more considered view of player performance.</p>
          <a className="text-link" href="/overview">Open the workspace <span aria-hidden="true">↓</span></a>
        </section>

        <section className="foundation" id="methodology" aria-labelledby="foundation-title">
          <div className="foundation-copy">
            <p className="eyebrow">A transparent starting point</p>
            <h2 id="foundation-title">Every forecast<br />starts with evidence.</h2>
            <p>The approach uses a player&apos;s latest five eligible appearances in covered leagues, with at least 60 minutes played in each completed match. Opponent strength adds context. Missing history keeps a forecast unavailable.</p>
            <span className="foundation-label">Explainable estimates · evidence included</span>
          </div>
          <div className="principles" aria-label="Prediction principles">
            <div><span className="principle-number">05</span><p>Latest eligible league appearances</p></div>
            <div><span className="principle-number">60<span> min</span></span><p>Minimum time played per appearance</p></div>
            <div><span className="principle-number">01</span><p>Shared cutoff for a fair comparison</p></div>
          </div>
        </section>

        <section className="coverage" id="coverage" aria-labelledby="coverage-title">
          <div className="section-heading">
            <div><p className="eyebrow">Starting with real league data</p><h2 id="coverage-title">The opening lineup.</h2></div>
            <span className="season">2026 / 2027</span>
          </div>
          <div className="competition-grid">
            {competitions.map((competition) => (
              <article className="competition-card" key={competition.name}>
                <div className="competition-top"><span>{competition.country}</span><span>{competition.teams} clubs</span></div>
                <h3>{competition.name}</h3>
                <p>Covered regular-season competition · 2026/27</p>
                <div className="tier-line"><span>Upper / middle / lower</span><strong>{competition.tiers}</strong></div>
              </article>
            ))}
          </div>
        </section>

        <section className="coverage" id="about" aria-labelledby="about-title">
          <div className="section-heading">
            <div><p className="eyebrow">About the project</p><h2 id="about-title">Performance, in context.</h2></div>
          </div>
          <div className="competition-grid">
            <article className="competition-card">
              <div className="competition-top"><span>Match history</span></div>
              <h3>Start with what happened.</h3>
              <p>Observed statistics describe completed appearances. The latest five eligible appearances form a consistent window, with each new one replacing the oldest regardless of performance.</p>
            </article>
            <article className="competition-card">
              <div className="competition-top"><span>Looking ahead</span></div>
              <h3>Make the estimate clear.</h3>
              <p>Forecasts are estimates for a confirmed future fixture. A form index summarizes adjusted past performance. Each is labeled separately, with missing data and uncertainty visible.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span>Live Sports Prediction</span>
        <p>Football performance, with the evidence in view.</p>
        <a href="#methodology">Our approach <span aria-hidden="true">↑</span></a>
      </footer>
    </>
  );
}
