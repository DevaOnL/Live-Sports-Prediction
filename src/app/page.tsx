import Image from "next/image";
import Link from "next/link";
import { SiteMasthead } from "@/components/site-masthead";
import { MetricIcon } from "@/components/football-art";

export default function Home() {
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <SiteMasthead />
    <main id="main" tabIndex={-1}>
      <section className="home-hero" aria-labelledby="hero-title"><div className="home-hero-inner">
        <figure className="hero-photo"><Image src="/images/football-editorial.jpg" alt="A football on a grass pitch" fill priority sizes="(max-width: 700px) 90vw, 65vw" /></figure>
        <div className="hero-title"><span className="yellow-tab">Football. In focus.</span><h1 id="hero-title"><span>READ</span>{" "}<span>THE GAME.</span></h1><Link className="button" href="/overview">Open workspace <span aria-hidden="true">↗</span></Link></div>
      </div></section>
      <section className="home-content" aria-label="Explore football"><div className="visual-links">
        <Link href="/players" className="visual-link"><div className="visual-link-art editorial-link-art"><Image src="/images/players-editorial.jpg" alt="" fill sizes="(max-width: 700px) 90vw, 35vw" /></div><h2><span>FIND A PLAYER</span><span aria-hidden="true">↗</span></h2></Link>
        <Link href="/compare" className="visual-link"><div className="visual-link-art editorial-link-art"><Image src="/images/comparison-editorial.webp" alt="" fill sizes="(max-width: 700px) 90vw, 35vw" /></div><h2><span>COMPARE PLAYERS</span><span aria-hidden="true">⇄</span></h2></Link>
      </div><aside className="league-notes"><h2 className="yellow-tab">THE LINEUP</h2><span className="caption">Covered leagues · 2026/27</span>{[{name:"Premier League",country:"England",code:"ENG"},{name:"La Liga",country:"Spain",code:"ESP"}].map((league)=><div className="league-summary" key={league.code}><span className="league-badge" aria-hidden="true">{league.code}</span><div><h3>{league.name}</h3><p>{league.country}</p></div></div>)}<Link className="text-link" href="/overview">Explore the data ↗</Link></aside></section>
      <section className="method-strip" aria-label="Forecast method"><div><MetricIcon metric="rating" /><strong>5</strong><span>eligible matches</span></div><div><MetricIcon metric="minutes" /><strong>60<span> min</span></strong><span>minimum per match</span></div><div><MetricIcon metric="form" /><strong>90<span> min</span></strong><span>statistic rates</span></div></section>
      <p className="home-disclaimer">Forecasts are estimates.</p>
    </main><footer className="site-footer"><span>LIVE SPORTS PREDICTION</span><span>Football imagery is illustrative.</span><a href="/images/ATTRIBUTION.md">Photo credits ↗</a></footer>
  </>;
}
