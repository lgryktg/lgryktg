export function validateSnapshot(value) {
 const fail=message=>{throw new Error(message)};
 if(!value||typeof value!=='object'||Array.isArray(value)||value.schemaVersion!==1)fail('schemaVersion 必须为 1');
 for(const key of ['projects','models','tasks','alerts']){if(!Array.isArray(value[key])||value[key].length>50000)fail(key+' 必须是数组且不超过 50000 条');const ids=new Set();for(const row of value[key]){if(!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>100||ids.has(row.id))fail(key+' 包含无效或重复 ID');ids.add(row.id);}}
 const text=(v,k)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail(k+' 必须是非空文本（最长 2000 字）');};
 const num=(v,k,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||(integer&&!Number.isInteger(v)))fail(k+' 必须是非负'+(integer?'整数':'数字'));};
 const date=(v,k)=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(v)||!Number.isFinite(Date.parse(v)))fail(k+' 必须是 ISO 日期');};
 const projectIds=new Set(value.projects.map(p=>p.id)),modelIds=new Set(value.models.map(m=>m.id));
 for(const p of value.projects){for(const k of ['name','owner','stage'])text(p[k],'项目 '+k);num(p.episodes,'episodes',true);num(p.completedEpisodes,'completedEpisodes',true);if(p.completedEpisodes>p.episodes)fail('已完成集数不能超过计划集数');num(p.budget,'budget');date(p.dueAt,'dueAt');}
 for(const m of value.models)for(const k of ['name','provider','type'])text(m[k],'模型 '+k);
 for(const t of value.tasks){if(!projectIds.has(t.projectId)||!modelIds.has(t.modelId))fail('任务引用了不存在的项目或模型');if(!['queued','running','succeeded','failed','cancelled'].includes(t.status))fail('任务状态无效');if(!['pending','approved','rejected'].includes(t.review))fail('审核状态无效');num(t.episode,'episode',true);num(t.shot,'shot',true);num(t.cost,'cost');num(t.retries,'retries',true);if(t.durationMs!==null)num(t.durationMs,'durationMs');if(typeof t.costConfirmed!=='boolean')fail('costConfirmed 必须是布尔值');text(t.type,'任务类型');if(typeof t.error!=='string'||t.error.length>2000)fail('error 必须是文本且不超过 2000 字');date(t.createdAt,'createdAt');}
 for(const a of value.alerts){text(a.title,'告警标题');text(a.detail,'告警说明');if(!['critical','warning','info'].includes(a.severity)||!['open','acknowledged'].includes(a.status))fail('告警级别或状态无效');if(a.projectId&&!projectIds.has(a.projectId))fail('告警项目不存在');date(a.createdAt,'告警时间');}
 date(value.updatedAt,'updatedAt');
 return {...value,source:'import'};
}
