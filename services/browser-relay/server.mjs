import { createServer, request as httpRequest } from "node:http";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { allowedNavigationUrl } from "./browser-network-policy.mjs";
import { canvasLanded } from "./browser-network-policy.mjs";

const PORT = Number(process.env.PORT || 8081);
const CONTROL_SECRET = process.env.BROWSER_RELAY_CONTROL_SECRET || "";
const EGRESS_SECRET = process.env.BROWSER_EGRESS_REGISTRATION_SECRET || "";
const CALLBACK = (process.env.BROWSER_ORCHESTRATOR_CONTROL_URL || "http://browser-orchestrator:8080").replace(/\/$/, "");
const EGRESS_PROXY = (process.env.BROWSER_EGRESS_PROXY_CONTROL_URL || "http://browser-egress-proxy:3128").replace(/\/$/, "");
const PUBLIC_ORIGIN = process.env.BROWSER_PUBLIC_ORIGIN || "";
const MAX_HTTP = 4 * 1024 * 1024, MAX_BODY = 64 * 1024, MAX_CONNECTIONS = 64;
// Hard cap for one sign-in viewer (the orchestrator slides its own grant within
// it). A slow sign-in (typing, Duo push) must not be cut off at five minutes.
const VIEWER_MAX_TTL_SECONDS = 1800;
if (CONTROL_SECRET.length < 32 || EGRESS_SECRET.length < 32 || CONTROL_SECRET === EGRESS_SECRET) throw new Error("Distinct relay control and egress registration secrets are required");
try { const origin = new URL(PUBLIC_ORIGIN); if (origin.origin !== PUBLIC_ORIGIN || origin.protocol !== "https:" && !["localhost","127.0.0.1"].includes(origin.hostname)) throw new Error(); }
catch { throw new Error("BROWSER_PUBLIC_ORIGIN must be an exact HTTPS origin (HTTP is allowed only for local development)"); }
const sessions = new Map(), capabilities = new Map(), nonces = new Map(), tombstones = new Map(), egressGenerations = new Map();
const relayEpoch = randomBytes(18).toString("base64url");
const sockets = new Map(); let activeConnections = 0, guardRunning = false;
const hash = (v) => createHash("sha256").update(v).digest("base64url");
const equal = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length&&timingSafeEqual(x,y); };
const send = (res,status,value) => { const body=JSON.stringify(value); res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","content-length":Buffer.byteLength(body)}); res.end(body); };
async function body(req){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>MAX_BODY)throw new Error("body");chunks.push(c);}const raw=Buffer.concat(chunks).toString("utf8");return{raw,value:raw?JSON.parse(raw):{}};}
function authenticated(req,path,raw){const ts=String(req.headers["x-relay-timestamp"]||""),nonce=String(req.headers["x-relay-nonce"]||""),sig=String(req.headers["x-relay-signature"]||"");if(!/^\d+$/.test(ts)||Math.abs(Date.now()-Number(ts))>60000||!/^[A-Za-z0-9_-]{16,}$/.test(nonce)||nonces.has(nonce))return false;const expected=createHmac("sha256",CONTROL_SECRET).update(`${req.method}\n${path}\n${ts}\n${nonce}\n${raw}`).digest("base64url");if(!equal(sig,expected))return false;nonces.set(nonce,Date.now()+60000);return true;}
// Top-level pages: exact Canvas origin, exact institution hosts, or a built-in
// trusted identity provider (suffix). Egress-only CDNs are NOT navigable.
const allowedUrl=(value,s)=>allowedNavigationUrl(value,s.canvasOrigin,s.authHostRules);// This service is intentionally isolated from uplink DNS. It enforces URL/host
// membership (exact rules + reviewed IdP suffixes); the egress proxy resolves and validates all answers at
// registration and again for every CONNECT before upstream bytes can flow.
function closeSession(id){for(const sock of sockets.get(id)||[])sock.destroy();sockets.delete(id);for(const[k,v]of capabilities)if(v.sessionId===id)capabilities.delete(k);}
function track(id,...items){const set=sockets.get(id)||new Set();for(const x of items){set.add(x);x.once("close",()=>{set.delete(x);if(!set.size)sockets.delete(id);});}sockets.set(id,set);}
function requestTarget(session,port,path,method="GET",headers={}){return new Promise((resolve,reject)=>{const req=httpRequest({hostname:session.target,port,path,method,headers:{...headers,host:port===9222?"localhost:9223":`${session.target}:${port}`},timeout:10000},res=>{const chunks=[];let n=0;res.on("data",c=>{n+=c.length;if(n>MAX_HTTP){req.destroy();reject(new Error("response too large"));}else chunks.push(c);});res.on("end",()=>resolve({status:res.statusCode||502,headers:res.headers,body:Buffer.concat(chunks)}));});req.on("timeout",()=>{req.destroy();reject(new Error("timeout"));});req.on("error",reject);req.end();});}
async function signedCallback(path,value){const raw=JSON.stringify(value),ts=String(Date.now()),nonce=randomBytes(18).toString("base64url"),sig=createHmac("sha256",CONTROL_SECRET).update(`POST\n${path}\n${ts}\n${nonce}\n${raw}`).digest("base64url");await fetch(`${CALLBACK}${path}`,{method:"POST",headers:{"content-type":"application/json","x-relay-timestamp":ts,"x-relay-nonce":nonce,"x-relay-signature":sig},body:raw,signal:AbortSignal.timeout(5000)}).catch(()=>undefined);}
async function registerEgress(target,hosts){const generation=egressGenerations.get(target)||randomBytes(18).toString("base64url");egressGenerations.set(target,generation);const path="/v1/register",raw=JSON.stringify({target,hosts,generation,ttlSeconds:90}),ts=String(Date.now()),nonce=randomBytes(18).toString("base64url"),sig=createHmac("sha256",EGRESS_SECRET).update(`PUT\n${path}\n${ts}\n${nonce}\n${raw}`).digest("base64url");const response=await fetch(`${EGRESS_PROXY}${path}`,{method:"PUT",headers:{"content-type":"application/json","x-relay-timestamp":ts,"x-relay-nonce":nonce,"x-relay-signature":sig},body:raw,signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error("egress registration failed");}
async function unregisterEgress(target){const generation=egressGenerations.get(target);if(!generation)return;egressGenerations.delete(target);const path="/v1/unregister",raw=JSON.stringify({target,generation}),ts=String(Date.now()),nonce=randomBytes(18).toString("base64url"),sig=createHmac("sha256",EGRESS_SECRET).update(`DELETE\n${path}\n${ts}\n${nonce}\n${raw}`).digest("base64url");await fetch(`${EGRESS_PROXY}${path}`,{method:"DELETE",headers:{"content-type":"application/json","x-relay-timestamp":ts,"x-relay-nonce":nonce,"x-relay-signature":sig},body:raw,signal:AbortSignal.timeout(5000)}).catch(()=>undefined);}
async function deleteRelaySession(session){closeSession(session.id);await unregisterEgress(session.target);sessions.delete(session.id);}
// reason: "disallowed-host" | "disallowed-scheme" (a real policy violation, tombstoned
// as NAVIGATION_BLOCKED) or "guard-unavailable" (CDP could not be probed; the
// orchestrator retires the browser WITHOUT a navigation tombstone so the app
// provisions a fresh one instead of reporting a bogus "redirect blocked").
async function block(session,hostname,reason="disallowed-host"){if(!sessions.has(session.id))return;const detail=hostname?{blockedHost:hostname}:{};if(reason!=="guard-unavailable")tombstones.set(session.id,{...detail,expiresAt:Date.now()+300000});await deleteRelaySession(session);console.warn(JSON.stringify({event:"relay_navigation_blocked",sessionId:session.id,reason,...detail}));await signedCallback("/v1/internal/navigation-blocked",{sessionId:session.id,reason,...detail});}
// Pages that render no remote content: blank/popup bootstrap tabs and Chromium's
// own error page for a failed load (the egress proxy already refused the bytes).
// Chromium's own UI (DevTools, chrome://downloads/history/settings…) is reachable by
// keyboard shortcuts forwarded through VNC. It renders no remote content, so close
// that tab instead of killing the whole sign-in; every other non-https scheme still blocks.
// view-source: (Ctrl+U) only re-renders an already-allowed page as text; close it too.
// The managed policy points the new-tab page at chrome://version/ so a stray
// Ctrl+N/Ctrl+T window stays on chrome: (closed here) instead of redirecting to a
// third-party new-tab page that would trip the host guard and end the sign-in.
const BROWSER_UI_SCHEMES=new Set(["chrome:","devtools:","chrome-untrusted:","view-source:"]);
const inertPage=(url)=>url===""||url==="about:blank"||/^chrome-error:\/\/chromewebdata\/?$/i.test(url);
const GUARD_UNAVAILABLE_MS=30000;
async function guard(){if(guardRunning)return;guardRunning=true;try{await Promise.all([...sessions.values()].map(guardSession));}finally{guardRunning=false;}}
async function guardSession(session){let targets=null;try{const r=await requestTarget(session,9222,"/json/list");if(r.status===200){targets=JSON.parse(r.body);if(!Array.isArray(targets))targets=null;}}catch{}
  if(!targets){
    // Fail closed only after a sustained outage, not on one slow probe while
    // Chromium is busy rendering a heavy SAML/MFA page on its single CPU.
    if(!session.firstProbe){if(Date.now()-session.registeredAt>60000)await block(session,undefined,"guard-unavailable");}
    else{session.guardFailingSince??=Date.now();if(Date.now()-session.guardFailingSince>=GUARD_UNAVAILABLE_MS)await block(session,undefined,"guard-unavailable");}
    return;}
  session.firstProbe=true;session.guardFailingSince=undefined;
  for(const t of targets){if(t?.type!=="page"||typeof t.url!=="string"||inertPage(t.url))continue;
    let parsed=null;try{parsed=new URL(t.url);}catch{}
    if(parsed&&BROWSER_UI_SCHEMES.has(parsed.protocol)&&typeof t.id==="string"&&/^[A-Za-z0-9-]+$/.test(t.id)){await requestTarget(session,9222,`/json/close/${t.id}`).catch(()=>undefined);console.warn(JSON.stringify({event:"relay_guard_closed_browser_ui",sessionId:session.id,scheme:parsed.protocol}));continue;}
    if(!parsed||parsed.protocol!=="https:"){console.warn(JSON.stringify({event:"relay_guard_scheme",sessionId:session.id,scheme:parsed?.protocol||"invalid"}));await block(session,undefined,"disallowed-scheme");return;}
    if(allowedUrl(t.url,session))continue;
    await block(session,parsed.hostname.toLowerCase(),"disallowed-host");return;}}
function capability(req,kind){const m=new RegExp(`^/proxy/${kind}/([A-Za-z0-9_-]+)(/.*)?$`).exec(new URL(req.url,"http://relay").pathname),entry=m&&capabilities.get(hash(m[1])),session=entry&&sessions.get(entry.sessionId);if(!m||!entry||entry.kind!==kind||entry.expiresAt<Date.now()||!session)return null;return{entry,session,path:m[2]||"/"};}
function proxyHttp(req,res,kind){const found=capability(req,kind);if(!found)return send(res,401,{error:"Relay capability expired"});const cdpLike=kind==="cdp"||kind==="mirror",port=cdpLike?9222:6080,path=kind==="viewer"?"/websockify":found.path;const upstream=httpRequest({hostname:found.session.target,port,path,method:req.method,headers:{...req.headers,host:cdpLike?"localhost:9223":`${found.session.target}:6080`},timeout:15000},incoming=>{let n=0;const chunks=[];incoming.on("data",c=>{n+=c.length;if(n>MAX_HTTP){upstream.destroy();res.destroy();}else chunks.push(c);});incoming.on("end",()=>{const out=Buffer.concat(chunks);res.writeHead(incoming.statusCode||502,{...incoming.headers,"content-length":out.length,"cache-control":"no-store"});res.end(out);});});upstream.on("error",()=>send(res,502,{error:"Relay target unavailable"}));req.pipe(upstream);}
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,"http://relay");
  try {
    if(req.method==="GET"&&url.pathname==="/health")return send(res,200,{ok:true,epoch:relayEpoch,ready:true});
    if(url.pathname.startsWith("/proxy/cdp/"))return proxyHttp(req,res,"cdp");
    // DOM-mirror capability (orchestrator only): HTTP is limited to discovering the browser endpoint.
    if(url.pathname.startsWith("/proxy/mirror/")){const found=capability(req,"mirror");if(!found||req.method!=="GET"||found.path!=="/json/version")return send(res,found?404:401,{error:"Relay capability expired"});return proxyHttp(req,res,"mirror");}
    const {raw,value}=await body(req);
    if(!authenticated(req,url.pathname,raw))return send(res,401,{error:"Unauthorized"});
    if(req.method==="PUT"&&/^\/v1\/sessions\/[0-9a-f-]{36}$/.test(url.pathname)){
      const id=url.pathname.split("/").at(-1);
      if(value.target!==`canvas-browser-${id}`||typeof value.canvasOrigin!=="string"||!Array.isArray(value.authHostRules))return send(res,400,{error:"Invalid fixed target"});
      const canvasHost=new URL(value.canvasOrigin).hostname.toLowerCase();
      const session={id,target:value.target,canvasOrigin:value.canvasOrigin,authHostRules:value.authHostRules,registeredAt:Date.now(),ready:false,firstProbe:false};
      await registerEgress(value.target,[canvasHost,...value.authHostRules]);
      sessions.set(id,session);
      return send(res,200,{registered:true});
    }
    const m=/^\/v1\/sessions\/([0-9a-f-]{36})(?:\/(capability|navigate|ready|revoke|landed))?$/.exec(url.pathname),session=m&&sessions.get(m[1]);
    if(!session){if(m&&req.method==="DELETE"&&!m[2])return send(res,200,{revoked:true});const t=m&&tombstones.get(m[1]);return t?.expiresAt>Date.now()?send(res,400,{code:"NAVIGATION_BLOCKED",blockedHost:t.blockedHost}):send(res,404,{error:"Session not registered"});}
    if(req.method==="DELETE"&&!m[2]){await deleteRelaySession(session);return send(res,200,{revoked:true});}
    if(req.method==="POST"&&m[2]==="revoke"){closeSession(session.id);return send(res,200,{revoked:true});}
    if(req.method==="POST"&&m[2]==="capability"){
      if(!["cdp","viewer","mirror"].includes(value.kind))return send(res,400,{error:"Invalid capability"});
      const rawToken=randomBytes(32).toString("base64url"),ttl=Math.min(value.kind==="cdp"?60:value.kind==="mirror"?900:VIEWER_MAX_TTL_SECONDS,Math.max(5,Number(value.ttlSeconds)||30));
      capabilities.set(hash(rawToken),{sessionId:session.id,kind:value.kind,expiresAt:Date.now()+ttl*1000});
      return send(res,201,{token:rawToken,expiresAt:Date.now()+ttl*1000});
    }
    if(req.method==="POST"&&m[2]==="navigate"){
      if(!allowedUrl(value.url,session))return send(res,400,{code:"NAVIGATION_BLOCKED",error:"Navigation blocked"});
      try {
        const r=await requestTarget(session,9222,`/json/new?${encodeURIComponent(value.url)}`,"PUT");
        if(r.status!==200)console.warn(JSON.stringify({event:"relay_navigation_failed",code:"UPSTREAM_STATUS",status:r.status}));
        return send(res,r.status===200?200:502,{navigated:r.status===200});
      }catch(error){
        console.warn(JSON.stringify({event:"relay_navigation_failed",code:typeof error?.code==="string"?error.code:"UPSTREAM_UNAVAILABLE"}));
        return send(res,502,{navigated:false});
      }
    }
    if(req.method==="GET"&&m[2]==="landed"){
      // Signed, boolean-only: never returns target URLs. "Landed" means a
      // top-level page is on the exact Canvas origin outside /login*.
      let targets=null;try{const r=await requestTarget(session,9222,"/json/list");if(r.status===200)targets=JSON.parse(r.body);}catch{}
      return send(res,200,{landed:Array.isArray(targets)&&targets.some(t=>t?.type==="page"&&typeof t.url==="string"&&canvasLanded(t.url,session.canvasOrigin))});
    }
    if(req.method==="GET"&&m[2]==="ready"){
      const [cdp,vnc]=await Promise.all([requestTarget(session,9222,"/json/version").catch(()=>null),requestTarget(session,6080,"/vnc.html").catch(()=>null)]);
      const ready=cdp?.status===200&&vnc?.status===200;if(ready)session.ready=true;
      return send(res,ready?200:503,{ready});
    }
    return send(res,404,{error:"Not found"});
  }catch{return send(res,500,{error:"Relay failure"});}
});
server.on("upgrade",(req,socket,head)=>{if(activeConnections>=MAX_CONNECTIONS)return socket.destroy();const kind=req.url.startsWith("/proxy/cdp/")?"cdp":req.url.startsWith("/proxy/viewer/")?"viewer":req.url.startsWith("/proxy/mirror/")?"mirror":null,found=kind&&capability(req,kind);if(!found||String(req.headers.upgrade||"").toLowerCase()!=="websocket"||!/upgrade/i.test(String(req.headers.connection||""))||req.headers["sec-websocket-version"]!=="13"||!req.headers["sec-websocket-key"])return socket.destroy();const origin=req.headers.origin;if(kind==="viewer"&&origin!==PUBLIC_ORIGIN||kind==="cdp"&&origin&&origin!==process.env.BROWSER_CONTROL_ORIGIN)return socket.destroy();
  // Mirror: browser-level CDP for the orchestrator's DOM-mirror engine only (never a browser Origin).
  if(kind==="mirror"&&(origin||!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(found.path)))return socket.destroy();
  activeConnections++;let settled=false;const done=()=>{if(!settled){settled=true;activeConnections=Math.max(0,activeConnections-1);}};const cdpLike=kind==="cdp"||kind==="mirror",port=cdpLike?9222:6080,path=kind==="viewer"?"/websockify":found.path;const upstreamHeaders={...req.headers,host:cdpLike?"localhost:9223":`${found.session.target}:6080`};if(kind==="viewer"){delete upstreamHeaders.cookie;delete upstreamHeaders.authorization;}const upstream=httpRequest({hostname:found.session.target,port,path,headers:upstreamHeaders});track(found.session.id,socket,upstream);upstream.on("upgrade",(response,upstreamSocket,upstreamHead)=>{const current=capability(req,kind);if(!current||current.session.id!==found.session.id){upstreamSocket.destroy();socket.destroy();return done();}track(found.session.id,upstreamSocket);socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join("\r\n")}\r\n\r\n`);if(head.length)upstreamSocket.write(head);if(upstreamHead.length)socket.write(upstreamHead);let bytes=0;const limit=(kind==="mirror"?512:64)*1024*1024,timer=setTimeout(()=>{socket.destroy();upstreamSocket.destroy();},Math.max(1,Math.min(kind==="viewer"?VIEWER_MAX_TTL_SECONDS*1000:kind==="mirror"?900000:300000,found.entry.expiresAt-Date.now())));for(const s of[socket,upstreamSocket])s.on("data",c=>{bytes+=c.length;if(bytes>limit){socket.destroy();upstreamSocket.destroy();}});socket.once("close",()=>{clearTimeout(timer);done();});upstreamSocket.pipe(socket).pipe(upstreamSocket);});upstream.on("response",response=>{response.resume();done();socket.destroy();});upstream.on("error",()=>{done();socket.destroy();});socket.once("close",()=>{upstream.destroy();done();});upstream.end();});
setInterval(()=>{const now=Date.now();for(const[k,v]of nonces)if(v<now)nonces.delete(k);for(const[k,v]of capabilities)if(v.expiresAt<now)capabilities.delete(k);for(const[k,v]of tombstones)if(v.expiresAt<now)tombstones.delete(k);void guard();},2000).unref();
setInterval(()=>{for(const session of sessions.values())void registerEgress(session.target,[new URL(session.canvasOrigin).hostname.toLowerCase(),...session.authHostRules]).catch(()=>undefined);},30000).unref();
server.listen(PORT,"0.0.0.0");
