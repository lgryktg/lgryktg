import {enrichUserLocations} from './ipLocation.mjs';
import http from 'node:http';
import {readFile,writeFile,rename,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {createDemo} from './demoData.mjs';
import {validateSnapshot} from './schema.mjs';
import {collectSystem,validateConnection,verifyRoot} from './systemCollector.mjs';
import {listUsers,userDetail,parseUserFilters} from './userAnalytics.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4318);
const host='127.0.0.1';
const token=process.env.ADMIN_TOKEN||'';
if((process.env.NODE_ENV==='production'||process.env.ALLIN_ADMIN_REQUIRE_AUTH==='1')&&token.length<32)throw new Error('上线模式必须设置至少 32 字符的独立 ADMIN_TOKEN，禁止普通业务用户访问全局监控数据');
const dataDir=process.env.ALLIN_ADMIN_DATA_DIR?path.resolve(process.env.ALLIN_ADMIN_DATA_DIR):path.join(directory,'data');
await mkdir(dataDir,{recursive:true});
let state;
try {state=JSON.parse(await readFile(path.join(dataDir,'state.json'),'utf8'));validateSnapshot(state.snapshot);if(!Array.isArray(state.audit))throw new Error('审计数据无效');} catch(error){if(error.code!=='ENOENT')throw error;state={snapshot:createDemo(),audit:[]};}
state.monitor??={active:{},samples:[],events:[]};
if(!state.connection){const sibling=path.resolve(directory,'../Toonflow-app-master');const available=!process.env.ALLIN_ADMIN_DATA_DIR&&await stat(path.join(sibling,'data/settings.json')).catch(()=>null);state.connection=available?{enabled:true,systemRoot:sibling,serviceUrl:'http://127.0.0.1:3000',intervalSeconds:10}:{enabled:false};}
state.connection=validateConnection(state.connection);
let queue=Promise.resolve();
function mutate(action){const run=queue.then(async()=>{const next=structuredClone(state);await action(next);const temp=path.join(dataDir,'state.'+randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(next,null,2));await rename(temp,path.join(dataDir,'state.json'));state=next;});queue=run.catch(()=>{});return run;}
function audit(next,action,detail){next.audit.unshift({id:randomUUID(),at:new Date().toISOString(),actor:'本机管理员',action,detail});next.audit=next.audit.slice(0,5000);}
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req){let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024){const error=new Error('文件不能超过 10 MB');error.status=413;throw error;}chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{const error=new Error('JSON 格式无效');error.status=400;throw error;}}
let liveSnapshot=null,collecting=null,nextCollection=0,lastAttemptAt=null,lastSuccessAt=null,collectionError='';
function reconcile(next,rules,now){const ids=new Set(rules.map(r=>r.id));for(const [key,alert] of Object.entries(next.monitor.active)){if(!ids.has(key)){next.monitor.events.unshift({at:now,type:'resolved',title:alert.title,id:alert.id});delete next.monitor.active[key];}}
 for(const rule of rules){const previous=next.monitor.active[rule.id];if(previous){next.monitor.active[rule.id]={...previous,...rule,id:previous.id,ruleId:rule.id};}else{const alert={...rule,id:randomUUID(),ruleId:rule.id,createdAt:now,status:'open'};next.monitor.active[rule.id]=alert;next.monitor.events.unshift({at:now,type:'triggered',title:alert.title,id:alert.id});}}next.monitor.events=next.monitor.events.slice(0,1000);}
async function sync(){
 if(!state.connection.enabled)return;
 if(collecting)return collecting;
 const connection=structuredClone(state.connection),key=JSON.stringify(connection);lastAttemptAt=new Date().toISOString();
 collecting=(async()=>{try{const snapshot=await collectSystem(connection);if(JSON.stringify(state.connection)!==key)return;
 await mutate(next=>{reconcile(next,snapshot.alerts,snapshot.updatedAt);next.monitor.samples.push({at:snapshot.updatedAt,online:snapshot.system.service.online,latencyMs:snapshot.system.service.latencyMs,cpuPercent:snapshot.system.host.cpuPercent,usedMemory:snapshot.system.host.totalMemory-snapshot.system.host.freeMemory,projects:snapshot.projects.length,tasks:snapshot.system.ledger.total});next.monitor.samples=next.monitor.samples.slice(-360);});
 liveSnapshot=snapshot;lastSuccessAt=snapshot.updatedAt;collectionError='';
 }catch(error){if(JSON.stringify(state.connection)!==key)return;collectionError=error.code?'采集失败（'+error.code+'），请检查目录和权限':error.message;await mutate(next=>{const rules=Object.values(next.monitor.active).filter(a=>a.ruleId!=='collectionFailure').map(a=>({...a,id:a.ruleId}));rules.push({id:'collectionFailure',severity:'critical',title:'原系统数据采集失败',detail:collectionError});reconcile(next,rules,new Date().toISOString());});
 }finally{collecting=null;nextCollection=Date.now()+(state.connection.intervalSeconds||10)*1000;}})();return collecting;
}
function currentSnapshot(){if(!state.connection.enabled)return {...state.snapshot,audit:state.audit,connection:{...state.connection,collecting:false}};
 const snapshot=liveSnapshot||{schemaVersion:1,source:'live',updatedAt:null,projects:[],models:[],tasks:[],alerts:[],system:null};
 return {...snapshot,alerts:Object.values(state.monitor.active),audit:state.audit,monitor:{samples:state.monitor.samples,events:state.monitor.events},connection:{...state.connection,collecting:!!collecting,lastAttemptAt,lastSuccessAt,error:collectionError,stale:!!collectionError}};
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 try {
 const expected='127.0.0.1:'+port;
 if(req.headers.host!==expected&&req.headers.host!=='localhost:'+port)return send(res,403,{error:'Host 不允许'});
 const url=new URL(req.url,'http://'+expected);
 if(url.pathname.startsWith('/api/')){
 if(token){const provided=Buffer.from(req.headers.authorization||'');const wanted=Buffer.from('Bearer '+token);if(provided.length!==wanted.length||!timingSafeEqual(provided,wanted))return send(res,401,{error:'请填写正确的管理令牌'});}
 if(req.method!=='GET'&&req.headers.origin&&!['http://'+expected,'http://localhost:'+port].includes(req.headers.origin))return send(res,403,{error:'请求来源不允许'});
 if(req.method==='GET'&&(url.pathname==='/api/users'||/^\/api\/users\/[^/]+$/.test(url.pathname))){
  try{const filters=parseUserFilters(url.searchParams);const result=url.pathname==='/api/users'?listUsers(state.connection,filters):userDetail(state.connection,decodeURIComponent(url.pathname.slice('/api/users/'.length)),filters);return send(res,200,await enrichUserLocations(result));}catch(error){if(error.status)return send(res,error.status,{error:error.message});console.error('用户数据读取失败',error.message);return send(res,503,{error:'用户数据读取失败，请检查原系统账本和后台日志'});}
 }
 if(req.method==='GET'&&url.pathname==='/api/template')return send(res,200,{...createDemo(),source:'import'});
 if(req.method==='GET'&&url.pathname==='/api/snapshot')return send(res,200,currentSnapshot());
 if(req.method==='POST'&&url.pathname==='/api/sync'){await sync();if(state.connection.enabled&&collectionError)return send(res,503,{error:collectionError});return send(res,200,{ok:true});}
 if(req.method==='POST'&&url.pathname==='/api/connection'){
 let connection;try{connection=validateConnection(await body(req));if(connection.enabled)connection=await verifyRoot(connection);}catch(error){return send(res,400,{error:error.message});}
 if(connection.enabled){const sourceRoot=await realpathOrResolve(connection.systemRoot);if(insideDirectory(sourceRoot,path.resolve(dataDir)))return send(res,400,{error:'后台数据目录不能位于原系统目录内部'});}
 await mutate(next=>{if(JSON.stringify(next.connection)!==JSON.stringify(connection))next.monitor={active:{},samples:[],events:[]};next.connection=connection;audit(next,connection.enabled?'连接原系统':'断开原系统',connection.enabled?connection.serviceUrl+' · '+connection.systemRoot:'恢复独立快照模式');});
 liveSnapshot=null;lastSuccessAt=null;collectionError='';nextCollection=0;if(collecting)await collecting;await sync();return send(res,200,{ok:true,connection:currentSnapshot().connection});}
 if(req.method==='POST'&&url.pathname==='/api/import'){
 if(state.connection.enabled)return send(res,409,{error:'实时监控已开启。请在连接设置中断开后再导入离线快照。'});
 let snapshot;try{snapshot=validateSnapshot(await body(req));}catch(error){return send(res,error.status||400,{error:error.message});}
 await mutate(next=>{next.snapshot=snapshot;audit(next,'导入数据','项目 '+snapshot.projects.length+' 个，任务 '+snapshot.tasks.length+' 条');});return send(res,200,{ok:true});}
 if(req.method==='POST'&&url.pathname==='/api/demo'){if(state.connection.enabled)return send(res,409,{error:'请先断开实时连接'});await mutate(next=>{next.snapshot=createDemo();audit(next,'切换示例数据','以示例数据替换当前监控快照');});return send(res,200,{ok:true});}
 if(req.method==='POST'&&url.pathname==='/api/alerts/acknowledge'){
 const {id}=await body(req);await mutate(next=>{const alert=next.connection.enabled?Object.values(next.monitor.active).find(a=>a.id===id):next.snapshot.alerts.find(a=>a.id===id);if(!alert){const error=new Error('告警不存在或已恢复');error.status=404;throw error;}if(alert.status==='acknowledged')return;alert.status='acknowledged';audit(next,'确认告警',alert.title);});return send(res,200,{ok:true});}
 return send(res,404,{error:'接口不存在'});
 }
 if(req.method!=='GET')return send(res,405,{error:'方法不支持'});
 const assets={'/':'index.html','/app.js':'app.js','/liveView.js':'liveView.js','/style.css':'style.css','/usersView.js':'usersView.js','/brandLogo.png':'brandLogo.png'};
 const asset=assets[url.pathname];if(!asset)return send(res,404,{error:'页面不存在'});
 const content=await readFile(path.join(directory,'public',asset));res.writeHead(200,{'Content-Type':asset.endsWith('.png')?'image/png':asset.endsWith('.css')?'text/css; charset=utf-8':asset.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(content);
 }catch(error){console.error(error);send(res,error.status||500,{error:error.status?error.message:'服务异常，请检查后台日志'});}
});
function insideDirectory(root,target){const offset=path.relative(root,target);return !path.isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+path.sep);}
async function realpathOrResolve(value){const {realpath}=await import('node:fs/promises');return await realpath(value).catch(()=>path.resolve(value));}
if(state.connection.enabled&&insideDirectory(await realpathOrResolve(state.connection.systemRoot),await realpathOrResolve(dataDir)))throw new Error('后台数据目录不能位于原系统目录内部');
await sync();
const timer=setInterval(()=>{if(state.connection.enabled&&Date.now()>=nextCollection&&!collecting)void sync().catch(error=>console.error('后台采集状态保存失败',error.message));},1000);timer.unref();
server.listen(port,host,()=>console.log('Allin Admin: http://'+host+':'+port));
