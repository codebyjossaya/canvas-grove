import {auth} from "@clerk/nextjs/server";
import {redirect} from "next/navigation";
import {Suspense} from "react";
import {QuizMode} from "@/components/ui/quiz-mode";

export default function QuizPage({params}:{params:Promise<{quizId:string}>}){
 return <Suspense fallback={<main className="boot quiz-boot"><p role="status">Opening quiz…</p></main>}><Protected params={params}/></Suspense>
}
async function Protected({params}:{params:Promise<{quizId:string}>}){const{quizId}=await params;const session=await auth();if(!session.userId)redirect("/sign-in");return <QuizMode quizId={quizId}/>}
