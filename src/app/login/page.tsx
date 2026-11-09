import Image from "next/image";
import { SiteMasthead } from "@/components/site-masthead";
import { LoginForm } from "./sign-in";

export default function Login() {
  return <><a className="skip-link" href="#main">Skip to content</a><SiteMasthead /><main className="account-shell" id="main" tabIndex={-1}><div className="account-layout"><div className="account-visual"><Image src="/images/football-editorial.jpg" alt="" fill priority sizes="(max-width: 700px) 90vw, 50vw" /><span>GET IN.<br />GAME ON.</span></div><section className="account-card" aria-labelledby="login-title"><h1 id="login-title">Sign in.</h1><LoginForm /></section></div></main></>;
}
