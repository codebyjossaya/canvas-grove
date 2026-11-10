import { SignInButton, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";
import { GroveMark, Icon } from "./icons";
import { ThemeControl } from "./theme-provider";

export function Landing() {
  return <main className="landing">
    <nav className="landing-nav"><Link className="brand" href="/" aria-label="Canvas Grove home"><GroveMark/><span>Canvas Grove</span></Link><div className="landing-actions"><ThemeControl compact/><SignInButton mode="modal"><button className="button ghost">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="button primary">Create your grove</button></SignUpButton></div></nav>
    <section className="hero"><div className="hero-copy"><p className="eyebrow">Your semester, finally in focus</p><h1>Everything in Canvas.<br/><em>Nothing in the way.</em></h1><p className="hero-lede">Canvas Grove brings assignments, grades, announcements, and study plans into one calm workspace that stays in sync.</p><div className="hero-actions"><SignUpButton mode="modal"><button className="button primary large">Get started <Icon name="arrow"/></button></SignUpButton><SignInButton mode="modal"><button className="button secondary large">I already have an account</button></SignInButton></div><p className="trust"><span><Icon name="check"/> Your Canvas password stays in Canvas</span><span><Icon name="check"/> Private by default</span></p></div><div className="hero-preview" aria-hidden="true"><div className="preview-top"><GroveMark/><span/><span/></div><div className="preview-body"><div className="preview-rail"><b/><i/><i/><i/><i/></div><div className="preview-content"><small>TODAY</small><h2>Here’s what needs your attention.</h2><div className="preview-focus"><div><span>UP NEXT</span><strong>Problem Set 6</strong><small>Linear Algebra · due tomorrow</small></div></div><div className="preview-grid"><div/><div/><div/></div></div></div></div></section>
    <footer className="landing-foot"><span>Canvas Grove</span><span>Works alongside Canvas. Your school stays the source of truth.</span></footer>
  </main>;
}
