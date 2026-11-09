import Link from "next/link";
import { LoginForm } from "./sign-in";

export default function Login() {
  return (
    <main className="account-shell" id="main">
      <Link className="account-brand" href="/">Live Sports Prediction <span aria-hidden="true">↗</span></Link>
      <section className="account-card" aria-labelledby="login-title">
        <p className="eyebrow">Welcome back</p>
        <h1 id="login-title">Sign in.</h1>
        <p className="account-intro">Use your viewer or administrator account.</p>
        <LoginForm />
      </section>
    </main>
  );
}
