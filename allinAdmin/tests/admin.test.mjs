import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../demoData.mjs';
import {validateSnapshot} from '../schema.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('快照校验：引用关系、唯一 ID、金额和交付进度',()=>{
 const demo=createDemo();assert.equal(validateSnapshot(demo).source,'import');
 const invalid=structuredClone(demo);invalid.tasks[0].projectId='missing';assert.throws(()=>validateSnapshot(invalid),/不存在/);
 const duplicate=structuredClone(demo);duplicate.tasks[1].id=duplicate.tasks[0].id;assert.throws(()=>validateSnapshot(duplicate),/重复/);
 const negative=structuredClone(demo);negative.tasks[0].cost=-1;assert.throws(()=>validateSnapshot(negative),/非负/);
 const progress=structuredClone(demo);progress.projects[0].completedEpisodes=999;assert.throws(()=>validateSnapshot(progress),/超过/);
 const time=structuredClone(demo);time.updatedAt='yesterday';assert.throws(()=>validateSnapshot(time),/ISO/);
});
test('独立服务：鉴权、来源校验、导入、并发确认和重启持久化',async()=>{
 const storage=await mkdtemp(path.join(tmpdir(),'allinAdminTest'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 let child;
 async function start(){child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),ADMIN_TOKEN:'test-only-token',ALLIN_ADMIN_DATA_DIR:storage},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('服务启动超时')),5000);child.once('error',reject);child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('服务退出 '+code));});});}
 async function stop(){if(child&&child.exitCode===null){const closed=new Promise(r=>child.once('exit',r));child.kill();await closed;}}
 const headers={Authorization:'Bearer test-only-token','Content-Type':'application/json'};
 const request=(url,options={})=>fetch('http://127.0.0.1:'+port+url,{...options,headers:{...headers,...options.headers}});
 try{await start();assert.equal((await fetch('http://127.0.0.1:'+port+'/api/snapshot')).status,401);
 assert.equal((await request('/api/snapshot')).status,200);
 assert.equal((await request('/api/demo',{method:'POST',headers:{Origin:'https://example.invalid'},body:'{}'})).status,403);
 assert.equal((await request('/api/import',{method:'POST',body:'{}'})).status,400);
 const source=createDemo();source.projects[0].name='独立导入测试';
 assert.equal((await request('/api/import',{method:'POST',body:JSON.stringify(source)})).status,200);
 const results=await Promise.all([1,2].map(()=>request('/api/alerts/acknowledge',{method:'POST',body:JSON.stringify({id:'al01'})})));assert.ok(results.every(r=>r.status===200));
 let saved=await (await request('/api/snapshot')).json();assert.equal(saved.source,'import');assert.equal(saved.alerts[0].status,'acknowledged');assert.equal(saved.audit.filter(a=>a.action==='确认告警').length,1);
 assert.equal((await request('/api/alerts/acknowledge',{method:'POST',body:JSON.stringify({id:'missing'})})).status,404);
 await stop();await start();saved=await (await request('/api/snapshot')).json();assert.equal(saved.projects[0].name,'独立导入测试');assert.equal(saved.audit.length,2);
 const template=await (await request('/api/template')).json();assert.equal(template.source,'import');assert.doesNotThrow(()=>validateSnapshot(template));
 assert.equal((await request('/')).headers.get('content-type'),'text/html; charset=utf-8');
 }finally{await stop();if(path.resolve(storage).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(storage).startsWith('allinAdminTest'))await rm(storage,{recursive:true,force:true});}
});
