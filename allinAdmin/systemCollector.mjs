import { readFile, readdir, stat, realpath, statfs, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const maxProjects = 256;
const maxFiles = 50000;
const kindNames = { text: '文本', image: '图片', video: '视频', audio: '音频' };
const imageExtensions = new Set(['.jpg','.jpeg','.png','.webp','.gif','.avif','.bmp']);
const videoExtensions = new Set(['.mp4','.mov','.webm','.mkv','.avi']);
const audioExtensions = new Set(['.mp3','.wav','.ogg','.m4a','.flac','.aac']);
let previousCpu;
const idFor = value => createHash('sha256').update(value).digest('hex').slice(0,24);
const inside = (root, target) => { const offset=path.relative(root,target); return !path.isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+path.sep); };
async function exists(file) { try { return await stat(file); } catch(error) { if(error.code==='ENOENT'||error.code==='ENOTDIR')return null; throw error; } }
async function json(file, limit=16*1024*1024) { const info=await stat(file); if(info.size>limit)throw new Error('文件超出采集上限'); return JSON.parse(await readFile(file,'utf8')); }
function cpuSample() { const sum=os.cpus().reduce((all,cpu)=>{all.idle+=cpu.times.idle;all.total+=Object.values(cpu.times).reduce((a,b)=>a+b,0);return all;},{idle:0,total:0});const previous=previousCpu;previousCpu=sum;return previous&&sum.total>previous.total?Math.max(0,Math.min(100,100*(1-(sum.idle-previous.idle)/(sum.total-previous.total)))):null; }
export function validateConnection(input) {
 if(!input||typeof input.enabled!=='boolean')throw new Error('enabled 必须是布尔值');
 if(!input.enabled)return {enabled:false};
 if(typeof input.systemRoot!=='string'||!path.isAbsolute(input.systemRoot))throw new Error('原系统目录必须为绝对路径');
 const url=new URL(input.serviceUrl);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('服务地址须为本机 HTTP 根地址，例如 http://127.0.0.1:3000');
 const intervalSeconds=input.intervalSeconds??10;
 if(!Number.isInteger(intervalSeconds)||intervalSeconds<5||intervalSeconds>300)throw new Error('采集周期应为 5 至 300 秒');
 return {enabled:true,systemRoot:path.resolve(input.systemRoot),serviceUrl:url.origin,intervalSeconds};
}
export async function verifyRoot(connection) {
 const directory=await realpath(connection.systemRoot);
 const pkg=await json(path.join(directory,'package.json'),1024*1024);
 if(pkg.name!=='toonflow')throw new Error('目录不是当前支持的 Toonflow / AllinDream 系统');
 const dataDir=path.join(directory,'data');if(!(await stat(dataDir)).isDirectory())throw new Error('原系统 data 目录不存在');
 return {...connection,systemRoot:directory};
}
async function probeService(origin) {
 const started=performance.now();
 try { const response=await fetch(origin+'/api/auth/status',{signal:AbortSignal.timeout(3000),redirect:'error'});const body=await response.json();const valid=response.ok&&body.code===200&&typeof body.data?.initialized==='boolean';return {url:origin,online:valid,status:response.status,latencyMs:Math.round(performance.now()-started),initialized:valid?body.data.initialized:null,error:valid?'':'响应不是预期的系统状态接口'}; }
 catch { return {url:origin,online:false,status:null,latencyMs:Math.round(performance.now()-started),initialized:null,error:'服务不可达、请求超时或状态响应无效'}; }
}
function readLedger(file) {
 const db=new DatabaseSync(file,{readOnly:true});
 try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
 const total=db.prepare('SELECT COUNT(*) AS count FROM usage').get().count;
 const accessReady=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accountAccess'").get()&&!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accountLogins'").get();
 const rows=db.prepare('SELECT id,source,kind,model,input,output,cacheRead,cacheWrite,units,status,createdAt FROM usage ORDER BY createdAt DESC,id DESC LIMIT 10000').all();
 const summary=db.prepare('SELECT source,kind,status,COUNT(*) AS requests,COALESCE(SUM(units),0) AS units FROM usage GROUP BY source,kind,status').all();
 const users=db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(disabled),0) AS disabled FROM users').get();
 const quotas=db.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(images),0) AS images,COALESCE(SUM(seconds),0) AS seconds FROM quotas').get();
 const reservations=db.prepare('SELECT kind,COUNT(*) AS count,COALESCE(SUM(units),0) AS units FROM reservations GROUP BY kind').all();
 db.exec('ROLLBACK');return {ok:true,total,rows,summary,users,quotas,reservations,accessReady,truncated:total>rows.length};
 }finally{db.close();}
}
async function scanProject(directory, name, owner, warnings) {
 const files=[],canvases=[],references=[];let visited=0,truncated=false;
 async function walk(current,depth=0) {
  if(depth>12){truncated=true;return;}
  for(const entry of await readdir(current,{withFileTypes:true})){
   if(visited++>=maxFiles){truncated=true;return;}
   if(entry.isSymbolicLink())continue;
   const full=path.join(current,entry.name);
   if(entry.isDirectory()) { if(!['.agent','.git','node_modules'].includes(entry.name))await walk(full,depth+1); }
   else if(entry.isFile()) {const info=await stat(full);const extension=path.extname(entry.name).toLowerCase();files.push({path:path.relative(directory,full),size:info.size,extension,modifiedAt:info.mtime.toISOString()});
    if(extension==='.json'&&info.size<=16*1024*1024){try {const value=await json(full);if(value.toonflowCanvas===true&&Array.isArray(value.nodes)){const nodes=value.nodes.map(node=>{const data=node.data||{};let selection=[];try {selection=JSON.parse(data.model||'[]');}catch{};const outputs=Object.values(data.outputs||{});const refs=outputs.flatMap(output=>typeof output?.value?.url==='string'?[output.value.url]:[]);if(typeof data.textPath==='string'&&data.textPath)refs.push(data.textPath);refs.forEach(ref=>references.push({ref,nodeId:String(node.id)}));return {id:String(node.id),type:String(node.type||'unknown'),label:typeof data.label==='string'?data.label:'',providerId:Array.isArray(selection)?String(selection[0]||''):'',modelName:Array.isArray(selection)?String(selection[1]||''):'',outputReferences:refs.length};});canvases.push({file:path.relative(directory,full),modifiedAt:info.mtime.toISOString(),nodeCount:nodes.length,nodes});}}catch {warnings.push(name+'：有 JSON 文件读取失败或正在写入');}}
   }
  }
 }
 await walk(directory);
 const byType={images:0,videos:0,audios:0,documents:0,other:0};let bytes=0;
 for(const file of files){bytes+=file.size;const key=imageExtensions.has(file.extension)?'images':videoExtensions.has(file.extension)?'videos':audioExtensions.has(file.extension)?'audios':['.txt','.md','.docx','.pdf'].includes(file.extension)?'documents':'other';byType[key]++;}
 const missing=[];let external=0,unsafe=0;
 for(const {ref,nodeId} of references){if(/^(https?:|data:|blob:)/i.test(ref)){external++;continue;}const target=path.resolve(directory,ref);if(!inside(directory,target)){unsafe++;continue;}try {const resolved=await realpath(target);if(!inside(directory,resolved)){unsafe++;continue;}if(!(await stat(resolved)).isFile())missing.push({nodeId,file:ref});}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')missing.push({nodeId,file:ref});else warnings.push(name+'：素材引用无法读取');}}
 if(truncated)warnings.push(name+'：文件扫描达到数量或深度上限');
 return {id:'project:'+idFor(directory.toLowerCase()),name,owner,directory,episodes:null,completedEpisodes:null,stage:canvases.length?'画布制作':'尚无画布',budget:null,dueAt:null,canvases,nodeCount:canvases.reduce((n,c)=>n+c.nodeCount,0),files:files.length,bytes,assets:byType,missingReferences:missing.slice(0,200),missingCount:missing.length,externalReferences:external,unsafeReferences:unsafe,truncated};
}
export async function collectSystem(connection) {
 const started=performance.now(),now=new Date().toISOString(),warnings=[];
 const source=await verifyRoot(connection),dataDir=path.join(source.systemRoot,'data');
 const servicePromise=probeService(source.serviceUrl);
 const document=await json(path.join(dataDir,'settings.json'));
 const settings=document.settings||{},models=[],candidates=new Map();
 function addCandidate(directory,name,owner) {if(typeof directory!=='string'||!path.isAbsolute(directory))return;const normalized=path.normalize(directory);if(!candidates.has(normalized.toLowerCase()))candidates.set(normalized.toLowerCase(),{directory:normalized,name:name||path.basename(normalized),owner});}
 let store=settings.stores?.['toonflow.projectList'];if(typeof store==='string'){try{store=JSON.parse(store);}catch{store=null;}}
 for(const project of store?.projectList||[])addCandidate(project.directory,project.name,'管理员工作区');
 async function discover(folder,owner){if(!await exists(folder))return;for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isDirectory()&&!entry.isSymbolicLink())addCandidate(path.join(folder,entry.name),entry.name,owner);}}
 await discover(path.join(dataDir,'workspaces'),'管理员工作区');
 const userRoot=path.join(dataDir,'users');if(await exists(userRoot))for(const entry of await readdir(userRoot,{withFileTypes:true})){if(entry.isDirectory()&&!entry.isSymbolicLink())await discover(path.join(userRoot,entry.name,'workspaces'),'成员工作区 '+entry.name.slice(0,8));}
 const projects=[],seen=new Set();
 for(const item of Array.from(candidates.values()).slice(0,maxProjects)){try {const canonical=await realpath(item.directory);const key=canonical.toLowerCase();if(seen.has(key))continue;seen.add(key);projects.push(await scanProject(canonical,item.name,item.owner,warnings));}catch{warnings.push(item.name+'：工作目录不存在或无法读取');}}
 if(candidates.size>maxProjects)warnings.push('项目数量超过 '+maxProjects+'，已截断');
 for(const provider of Array.isArray(settings.customProviders)?settings.customProviders:[]){for(const model of Array.isArray(provider.models)?provider.models:[]){if(typeof model.id!=='string')continue;models.push({id:'configured:'+idFor(String(provider.id)+':'+model.id),name:String(model.label||model.id),modelName:model.id,provider:String(provider.label||provider.id||'未命名'),providerId:String(provider.id||''),type:'文本',configured:true});}}
 for(const project of projects)for(const canvas of project.canvases)for(const node of canvas.nodes){if(!node.modelName)continue;const id='configured:'+idFor(node.providerId+':'+node.modelName);if(!models.some(m=>m.id===id))models.push({id,name:node.modelName,modelName:node.modelName,provider:node.providerId||'未记录',providerId:node.providerId,type:/image/i.test(node.type)?'图片':/video/i.test(node.type)?'视频':/audio/i.test(node.type)?'音频':'文本',configured:false,observedInCanvas:true});}
 let ledger;
 try{ledger=readLedger(path.join(dataDir,'accounts.sqlite'));}catch{ledger={ok:false,total:0,rows:[],summary:[],users:null,quotas:null,reservations:[],truncated:false};warnings.push('调用用量账本读取失败，保留为未知状态');}
 const tasks=ledger.rows.map(row=>{const id='ledger:'+idFor(row.kind+':'+row.model);if(!models.some(m=>m.id===id))models.push({id,name:row.model,modelName:row.model,provider:'用量账本未记录供应商',providerId:null,type:kindNames[row.kind]||row.kind,configured:false,fromLedger:true});return {id:row.id,projectId:null,episode:null,shot:null,modelId:id,type:kindNames[row.kind]||row.kind,status:({completed:'succeeded',failed:'failed',pending:'running',unknown:'unknown',cancelled:'cancelled'})[row.status]||'unknown',sourceStatus:row.status,createdAt:row.createdAt,durationMs:null,cost:null,costConfirmed:false,review:'unknown',error:'',retries:0,retriesKnown:false,units:row.units,input:row.input,output:row.output,cacheRead:row.cacheRead,cacheWrite:row.cacheWrite,apiSource:row.source};});
 const inventory={};for(const key of ['nodes','tools','providers','ext','skills']){try{const items=await readdir(path.join(dataDir,key),{withFileTypes:true});inventory[key]=items.filter(entry=>!entry.name.startsWith('.')&&!entry.isSymbolicLink()).length;}catch{inventory[key]=null;}}
 const libraryDir=path.join(dataDir,'assets');let library=null;if(await exists(libraryDir)){try{const result=await scanProject(await realpath(libraryDir),'全局素材库','系统',warnings);library={files:result.files,bytes:result.bytes,assets:result.assets,truncated:result.truncated};}catch{warnings.push('全局素材库无法读取');}}
 const service=await servicePromise;let disk=null;try{const info=await statfs(dataDir);disk={totalBytes:info.blocks*info.bsize,availableBytes:info.bavail*info.bsize};}catch{warnings.push('磁盘空间信息读取失败');}
 const adminExists=!!await exists(path.join(dataDir,'account.json'));
 const totals={projects:projects.length,canvases:projects.reduce((n,p)=>n+p.canvases.length,0),nodes:projects.reduce((n,p)=>n+p.nodeCount,0),files:projects.reduce((n,p)=>n+p.files,0),bytes:projects.reduce((n,p)=>n+p.bytes,0),images:projects.reduce((n,p)=>n+p.assets.images,0),videos:projects.reduce((n,p)=>n+p.assets.videos,0),audios:projects.reduce((n,p)=>n+p.assets.audios,0),missing:projects.reduce((n,p)=>n+p.missingCount,0),externalReferences:projects.reduce((n,p)=>n+p.externalReferences,0)};
 const rules=[];
 if(!service.online)rules.push({id:'serviceOffline',severity:'critical',title:'原系统服务不可达',detail:source.serviceUrl+' 状态探测失败。磁盘数据仍可采集。'});
 if(!ledger.ok)rules.push({id:'ledgerUnavailable',severity:'critical',title:'用量账本读取失败',detail:'请检查原系统数据库文件是否存在及本机读取权限。'});
 for(const project of projects)if(project.missingCount)rules.push({id:'missing:'+project.id,severity:'warning',title:project.name+' 存在失效素材引用',detail:project.missingCount+' 个节点素材引用指向不存在的文件。',projectId:project.id});
 if(disk&&disk.totalBytes&&disk.availableBytes/disk.totalBytes<0.1)rules.push({id:'diskLow',severity:'warning',title:'原系统所在磁盘可用空间不足 10%',detail:'请及时整理素材并备份项目。'});
 if(warnings.length)rules.push({id:'collectionPartial',severity:'warning',title:'部分数据未能完整采集',detail:[...new Set(warnings)].slice(0,5).join('；')});
 const coverage=[{name:'注册用户与登录 IP',state:ledger.ok?(ledger.accessReady?'connected':'unavailable'):'error',detail:'独立用户 API 按需读取注册资料、完整 IP、最近 90 天登录历史；不返回密码、密钥或创作内容'},{name:'全局素材库及插件清单',state:'connected',detail:'统计全局素材文件与 nodes / tools / providers / ext / skills 安装项数量，不执行插件源码'},{name:'原系统在线状态',state:'connected',detail:'每轮探测 /api/auth/status；不使用原系统登录凭证'},{name:'项目与画布节点',state:'connected',detail:'全局项目登记 + 管理员与成员工作区，按真实路径去重'},{name:'本地素材及引用',state:'connected',detail:'读取文件元数据并检查相对引用；不下载远程素材，不读取媒体正文'},{name:'全系统调用用量',state:ledger.ok?'connected':'error',detail:'只读 SQLite；当前 '+ledger.total+' 条记录，最多显示最近 10000 条'},{name:'调用与项目/分镜关联',state:'unavailable',detail:'当前 usage 表没有项目、画布、分镜字段，不推测归属'},{name:'调用耗时、错误详情',state:'unavailable',detail:'当前 usage 表没有结束时间、耗时及错误正文'},{name:'人民币成本与审核',state:'unavailable',detail:'原系统未持久化账单金额或内容审核状态；显示未采集'},{name:'节点实时执行状态',state:'unavailable',detail:'节点生成状态保存在浏览器内存；仅采集已落盘节点与服务端用量状态'},{name:'成员账号与配额汇总',state:ledger.ok?'connected':'error',detail:'只采集数量与额度合计，不读取账号密码、加密偏好或邮件正文'},{name:'主机资源',state:'connected',detail:'本机 CPU、内存和磁盘，非原系统进程独占占用'}];
 return {schemaVersion:1,source:'live',updatedAt:now,projects,models,tasks,alerts:rules,system:{service,systemRoot:source.systemRoot,dataDirectory:dataDir,intervalSeconds:source.intervalSeconds,collectionMs:Math.round(performance.now()-started),warnings:[...new Set(warnings)],totals,inventory,library,ledger:{...ledger,rows:undefined},accounts:{adminConfigured:adminExists,users:ledger.users,quotas:ledger.quotas,reservations:ledger.reservations},host:{cpuPercent:cpuSample(),totalMemory:os.totalmem(),freeMemory:os.freemem(),uptimeSeconds:os.uptime(),disk},coverage}};
}
