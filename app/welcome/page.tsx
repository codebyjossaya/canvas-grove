import{auth}from"@clerk/nextjs/server";import{redirect}from"next/navigation";import{Suspense}from"react";import{Orientation}from"@/components/ui/orientation";
export default function WelcomePage(){return <Suspense fallback={<div className="boot" aria-label="Loading orientation"/>}><ProtectedWelcome/></Suspense>}
async function ProtectedWelcome(){const session=await auth();if(!session.userId)redirect("/sign-in");return <Orientation/>}
