import crypto from "node:crypto";
import { chromium } from "playwright-core";

const id = process.env.PROVIDER_ID;
const base = process.env.BROWSER_ORCHESTRATOR_URL?.replace(/\/$/, "");
const secret = process.env.BROWSER_ORCHESTRATOR_SECRET;
if (!id || !base || !secret) throw new Error("Audit environment unavailable");
async function signed(path) {
  const method="GET",timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString("base64url"),body="";
  const signature=crypto.createHmac("sha256",secret).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`).digest("base64url");
  const r=await fetch(`${base}${path}`,{headers:{"x-orchestrator-timestamp":timestamp,"x-orchestrator-nonce":nonce,"x-orchestrator-signature":signature}});
  if(!r.ok) throw new Error(`orchestrator ${r.status}`); return r.json();
}
const {cdpUrl}=await signed(`/v1/sessions/${encodeURIComponent(id)}/connect`);
const browser=await chromium.connectOverCDP(cdpUrl,{timeout:90_000});
try {
  const page=browser.contexts()[0].pages().find(p=>p.url().startsWith("https://ufl.instructure.com"))??browser.contexts()[0].pages()[0];
  const result=await page.evaluate(async()=>{
    async function get(path){const r=await fetch(path,{credentials:"include",headers:{accept:"application/json"}});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={raw:text.slice(0,1000)}};if(!r.ok)throw new Error(`${path}: ${r.status}`);return data}
    const courses=await get('/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term&per_page=100');
    const course=courses.find(c=>/MAR\s*3023|marketing/i.test(`${c.course_code||''} ${c.name||''}`));
    if(!course)return{courses:courses.map(c=>({id:c.id,name:c.name,code:c.course_code}))};
    const cid=course.id;
    const [detail,tabs,groups,modules,pages,files,announcements]=await Promise.all([
      get(`/api/v1/courses/${cid}?include[]=syllabus_body&include[]=total_scores&include[]=term`),
      get(`/api/v1/courses/${cid}/tabs`),
      get(`/api/v1/courses/${cid}/assignment_groups?include[]=assignments&include[]=submission&include[]=score_statistics&override_assignment_dates=true&per_page=100`),
      get(`/api/v1/courses/${cid}/modules?include[]=items&per_page=100`),
      get(`/api/v1/courses/${cid}/pages?per_page=100`),
      get(`/api/v1/courses/${cid}/files?per_page=100`),
      get(`/api/v1/announcements?context_codes[]=course_${cid}&per_page=100`)
    ]);
    const cleanAssignment=a=>({id:a.id,name:a.name,points:a.points_possible,due:a.due_at,unlock:a.unlock_at,lock:a.lock_at,omit:a.omit_from_final_grade,extra:a.is_quiz_assignment?undefined:a.extra_credit,submission:a.submission&&{score:a.submission.score,grade:a.submission.grade,submitted:a.submission.submitted_at,excused:a.submission.excused,missing:a.submission.missing,late:a.submission.late,workflow:a.submission.workflow_state},url:a.html_url,description:(a.description||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,700)});
    return {course:{id:cid,name:course.name,code:course.course_code,enrollments:course.enrollments,term:course.term},detail:{grading_standard_id:detail.grading_standard_id,apply_group_weights:detail.apply_assignment_group_weights,syllabus:detail.syllabus_body},tabs:tabs.map(t=>({id:t.id,label:t.label,hidden:t.hidden,url:t.html_url})),groups:groups.map(g=>({id:g.id,name:g.name,weight:g.group_weight,rules:g.rules,position:g.position,assignments:(g.assignments||[]).map(cleanAssignment)})),modules:modules.map(m=>({id:m.id,name:m.name,state:m.state,unlock:m.unlock_at,items:(m.items||[]).map(i=>({id:i.id,title:i.title,type:i.type,content_id:i.content_id,url:i.html_url,completion:i.completion_requirement}))})),pages:pages.map(p=>({url:p.url,title:p.title,updated:p.updated_at,front:p.front_page})),files:files.map(f=>({id:f.id,name:f.display_name,filename:f.filename,content_type:f['content-type'],url:f.url,updated:f.updated_at})),announcements:announcements.map(a=>({id:a.id,title:a.title,posted:a.posted_at,delayed:a.delayed_post_at,message:(a.message||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,1200)}))};
  });
  console.log(JSON.stringify(result));
} finally {await browser.close()}
