"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { Icon } from "./icons";

const links = [
  { href: "/", icon: "home", label: "Today" },
  { href: "/planner", icon: "calendar", label: "Planner" },
  { href: "/courses", icon: "book", label: "Courses" },
  { href: "/quizzes", icon: "check", label: "Quizzes" },
  { href: "/inbox", icon: "inbox", label: "Inbox" },
  { href: "/settings", icon: "settings", label: "Settings" },
];

// The legacy grade picker lives under Courses in the navigation.
function activeHref(pathname: string) {
  if (pathname === "/") return "/";
  if (pathname.startsWith("/grades")) return "/courses";
  return links.find(link => link.href !== "/" && (pathname === link.href || pathname.startsWith(`${link.href}/`)))?.href ?? null;
}

// usePathname() is request data on dynamic routes, so it sits behind Suspense. The fallback is
// the same nav without the active marker, which keeps the static shell layout identical.
export function SideNav() {
  return <Suspense fallback={<NavLinks active={null}/>}><ActiveNav/></Suspense>;
}

function ActiveNav() {
  return <NavLinks active={activeHref(usePathname() ?? "/")}/>;
}

function NavLinks({ active }: { active: string | null }) {
  return <nav className="side-nav" aria-label="Workspace">
    {links.map(item => <Link key={item.href} href={item.href} className={active === item.href ? "active" : undefined} aria-current={active === item.href ? "page" : undefined}><Icon name={item.icon}/><span>{item.label}</span></Link>)}
  </nav>;
}
