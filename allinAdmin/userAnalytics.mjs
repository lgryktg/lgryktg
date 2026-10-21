import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const kinds=['text','image','video','audio'];
const metrics=[
 "COUNT(*) AS requests",
 "SUM(CASE WHEN kind='text' THEN 1 ELSE 0 END) AS textRequests",
 "SUM(CASE WHEN kind='image' THEN 1 ELSE 0 END) AS imageRequests",
 "SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) AS videoRequests",
 "SUM(CASE WHEN kind='audio' THEN 1 ELSE 0 END) AS audioRequests",
 "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed",
 "SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed",
 "SUM(CASE WHEN status IN ('pending','unknown') THEN 1 ELSE 0 END) AS unsettled",
 "SUM(CASE WHEN kind='text' THEN COALESCE(input,0) ELSE 0 END) AS inputTokens",
 "SUM(CASE WHEN kind='text' THEN COALESCE(output,0) ELSE 0 END) AS outputTokens",
 "SUM(CASE WHEN kind='text' THEN COALESCE(cacheRead,0) ELSE 0 END) AS cacheReadTokens",
 "SUM(CASE WHEN kind='text' THEN COALESCE(cacheWrite,0) ELSE 0 END) AS cacheWriteTokens",
 "SUM(CASE WHEN kind='text' THEN CASE WHEN status NOT IN ('pending','unknown') THEN units ELSE COALESCE(input,0)+COALESCE(output,0)+COALESCE(cacheRead,0)+COALESCE(cacheWrite,0) END ELSE 0 END) AS totalTokens",
 "SUM(CASE WHEN kind='text' AND status IN ('pending','unknown') THEN 1 ELSE 0 END) AS unsettledTextRequests",
 ...['input','output','cacheRead','cacheWrite'].map(field=>"SUM(CASE WHEN kind='text' AND "+field+" IS NOT NULL THEN 1 ELSE 0 END) AS "+field+'ReportedRequests'),
 "SUM(CASE WHEN kind='text' AND (status NOT IN ('pending','unknown') OR input IS NOT NULL OR output IS NOT NULL OR cacheRead IS NOT NULL OR cacheWrite IS NOT NULL) THEN 1 ELSE 0 END) AS tokenReportedRequests",
 "SUM(CASE WHEN kind='text' AND (input IS NULL OR output IS NULL OR cacheRead IS NULL OR cacheWrite IS NULL) THEN 1 ELSE 0 END) AS unknownTokenRequests",
 ...kinds.filter(k=>k!=='text').map(k=>"SUM(CASE WHEN kind='"+k+"' AND status NOT IN ('pending','unknown') THEN units ELSE 0 END) AS "+k+'Units'),
 "SUM(CASE WHEN source='platform' THEN 1 ELSE 0 END) AS platformRequests",
 "SUM(CASE WHEN source='personal' THEN 1 ELSE 0 END) AS personalRequests"
];
const metricNames=metrics.map(expression=>expression.split(' AS ').at(-1));
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
export function parseUserFilters(params) {
 const days=Number(params.get('days')??7),page=Number(params.get('page')??1),size=Number(params.get('size')??20),loginPage=Number(params.get('loginPage')??1);
 if(![0,1,7,30,90].includes(days))invalid('统计周期无效');
 if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(size)||size<1||size>100||!Number.isInteger(loginPage)||loginPage<1||loginPage>100000)invalid('分页参数无效');
 const search=(params.get('search')||'').trim(),status=params.get('status')||'',focus=params.get('focus')||'',model=params.get('model')||'',sort=params.get('sort')||'recent';
 if(search.length>200||model.length>200)invalid('筛选内容过长');
 if(!['','enabled','disabled'].includes(status)||!['','text','image','video','audio','mixed','none'].includes(focus)||!['recent','registered','tokens','requests'].includes(sort))invalid('筛选参数无效');
 return {days,page,size,loginPage,search,status,focus,model,sort};
}
function open(connection) {
 if(!connection.enabled)throw Object.assign(new Error('请先连接真实系统，用户资料不使用示例数据'),{status:409});
 const db=new DatabaseSync(path.join(connection.systemRoot,'data/accounts.sqlite'),{readOnly:true});
 try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');return db;}catch(error){db.close();throw error;}
}
function hasTable(db,name){return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function queryContext(db,filters) {
 const accessReady=hasTable(db,'accountAccess'),historyReady=hasTable(db,'accountLogins');
 const cutoff=filters.days?new Date(Date.now()-filters.days*86400000).toISOString():null;
 const conditions=[],args=[];
 if(cutoff){conditions.push('createdAt>=?');args.push(cutoff);}
 if(filters.model){conditions.push('model=?');args.push(filters.model);}
 const usageWhere=conditions.length?' WHERE '+conditions.join(' AND '):'';
 const focusExpression="CASE WHEN requests=0 THEN 'none' WHEN textRequests>MAX(imageRequests,videoRequests,audioRequests) THEN 'text' WHEN imageRequests>MAX(textRequests,videoRequests,audioRequests) THEN 'image' WHEN videoRequests>MAX(textRequests,imageRequests,audioRequests) THEN 'video' WHEN audioRequests>MAX(textRequests,imageRequests,videoRequests) THEN 'audio' ELSE 'mixed' END";
 const base='WITH activity AS (SELECT userId,'+metrics.join(',')+' FROM usage'+usageWhere+' GROUP BY userId),people AS (SELECT users.id,users.email,users.disabled,users.createdAt,'+
 (accessReady?'accountAccess.registeredIp,accountAccess.lastLoginIp,accountAccess.lastLoginAt,':'NULL AS registeredIp,NULL AS lastLoginIp,NULL AS lastLoginAt,')+
 metricNames.map(name=>'COALESCE(activity.'+name+',0) AS '+name).join(',')+',quotas.tokens AS remainingTokens,quotas.images AS remainingImages,quotas.seconds AS remainingSeconds,(SELECT MAX(createdAt) FROM usage WHERE userId=users.id) AS lastUsedAt FROM users LEFT JOIN activity ON activity.userId=users.id LEFT JOIN quotas ON quotas.userId=users.id'+(accessReady?' LEFT JOIN accountAccess ON accountAccess.userId=users.id':'')+'),scored AS (SELECT *,'+focusExpression+' AS focus FROM people) ';
 const clauses=[],cohortArgs=[];
 if(filters.search){const needle='%'+filters.search.replace(/[\\%_]/g,'\\$&')+'%';clauses.push("(email LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR COALESCE(registeredIp,'') LIKE ? ESCAPE '\\' OR COALESCE(lastLoginIp,'') LIKE ? ESCAPE '\\')");cohortArgs.push(needle,needle,needle,needle);}
 if(filters.status)clauses.push('disabled='+(filters.status==='disabled'?'1':'0'));
 if(filters.focus){clauses.push('focus=?');cohortArgs.push(filters.focus);}
 const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
 return {base,args,where,cohortArgs,cutoff,usageWhere,accessReady,historyReady};
}
function summarize(db,context) {
 const {base,args,where,cohortArgs}=context;
 return db.prepare(base+'SELECT COUNT(*) AS totalUsers,COALESCE(SUM(CASE WHEN disabled=0 THEN 1 ELSE 0 END),0) AS enabledUsers,COALESCE(SUM(CASE WHEN requests>0 THEN 1 ELSE 0 END),0) AS activeUsers,'+metricNames.map(name=>'COALESCE(SUM('+name+'),0) AS '+name).join(',')+' FROM scored'+where).get(...args,...cohortArgs);
}
function extraWhere(conditions,args,filters,cutoff){if(cutoff){conditions.push('usage.createdAt>=?');args.push(cutoff);}if(filters.model){conditions.push('usage.model=?');args.push(filters.model);}return ' WHERE '+conditions.join(' AND ');}
function trendRows(db,filters,context,userId) {
 const conditions=['usage.userId IN (SELECT id FROM scored'+context.where+')'],tailArgs=[...context.cohortArgs];
 if(userId){conditions.push('usage.userId=?');tailArgs.push(userId);}
 const days=filters.days?Math.min(filters.days,90)+1:30;
 const from=new Date(Date.now()+8*3600000);from.setUTCHours(0,0,0,0);from.setTime(from.getTime()-8*3600000-(days-1)*86400000);if(Date.now()-from.getTime()>(days+1)*86400000)throw new Error('日期范围异常');
 const trendCutoff=context.cutoff&&context.cutoff>from.toISOString()?context.cutoff:from.toISOString();
 const tail=extraWhere(conditions,tailArgs,filters,trendCutoff);
 const rows=db.prepare(context.base+"SELECT date(usage.createdAt,'+8 hours') AS day,"+metrics.join(',')+' FROM usage'+tail+" GROUP BY date(usage.createdAt,'+8 hours') ORDER BY day").all(...context.args,...tailArgs);
 return {days,rows};
}
function modelRows(db,filters,context,userId) {
 const conditions=['usage.userId IN (SELECT id FROM scored'+context.where+')'],tailArgs=[...context.cohortArgs];
 if(userId){conditions.push('usage.userId=?');tailArgs.push(userId);}
 const tail=extraWhere(conditions,tailArgs,filters,context.cutoff);
 return db.prepare(context.base+'SELECT usage.model,usage.kind,'+metrics.join(',')+' FROM usage'+tail+' GROUP BY usage.model,usage.kind ORDER BY requests DESC,usage.model LIMIT 30').all(...context.args,...tailArgs);
}
function videoOutputSummary(db) {
 const tracked=db.prepare('PRAGMA table_info(usage)').all().some(column=>column.name==='outputCount');
 const countExpression=tracked?'COALESCE(SUM(outputCount),0)':'0';
 const known=tracked?'outputCount IS NOT NULL':'0';
 const summary=db.prepare("SELECT "+countExpression+" AS total,SUM(CASE WHEN "+known+" THEN 0 ELSE 1 END) AS untrackedRequests FROM usage WHERE kind='video' AND status='completed'").get();
 return {total:summary.total,untrackedRequests:summary.untrackedRequests||0,trackingReady:tracked,scope:'allAccounts',unit:'videoOutputs',updatedAt:new Date().toISOString()};
}
export function listUsers(connection,filters) {
 const db=open(connection);
 try{const context=queryContext(db,filters);const summary=summarize(db,context);
 const pageCount=Math.max(1,Math.ceil(summary.totalUsers/filters.size)),page=Math.min(filters.page,pageCount);
 const order={recent:"MAX(COALESCE(lastUsedAt,''),COALESCE(lastLoginAt,''),createdAt) DESC,id",registered:'createdAt DESC,id',tokens:'totalTokens DESC,requests DESC,id',requests:'requests DESC,id'}[filters.sort];
 const users=db.prepare(context.base+'SELECT * FROM scored'+context.where+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...context.args,...context.cohortArgs,filters.size,(page-1)*filters.size);
 const models=db.prepare('SELECT DISTINCT model FROM usage WHERE userId IN (SELECT id FROM users) ORDER BY model LIMIT 2000').all().map(row=>row.model);
 return {updatedAt:new Date().toISOString(),scope:'registeredUsers',videoOutputs:videoOutputSummary(db),filters:{...filters,page},summary,users,pageCount,models,trend:trendRows(db,filters,context),modelStats:modelRows(db,filters,context),access:{ready:context.accessReady,historyReady:context.historyReady,retentionDays:90},note:'仅统计注册用户，不包含本机管理员；聚合查询完整用量账本，不受监控快照最近 10000 条限制'};
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}
export function userDetail(connection,userId,filters) {
 if(typeof userId!=='string'||userId.length>100)invalid('用户 ID 无效');
 const db=open(connection);
 try{const context=queryContext(db,{...filters,search:'',status:'',focus:''});
 const user=db.prepare(context.base+'SELECT * FROM scored WHERE id=?').get(...context.args,userId);
 if(!user)throw Object.assign(new Error('注册用户不存在'),{status:404});
 const args=[userId],conditions=['userId=?'];
 if(context.cutoff){conditions.push('createdAt>=?');args.push(context.cutoff);}if(filters.model){conditions.push('model=?');args.push(filters.model);}
 const records=db.prepare('SELECT id,userId,kind,model,source,status,units,input,output,cacheRead,cacheWrite,createdAt FROM usage WHERE '+conditions.join(' AND ')+' ORDER BY createdAt DESC,id DESC LIMIT 50').all(...args);
 const since=new Date(Date.now()-90*86400000).toISOString();let history=[],historyTotal=0;const size=20;
 if(context.historyReady){historyTotal=db.prepare('SELECT COUNT(*) AS count FROM accountLogins WHERE userId=? AND createdAt>=?').get(userId,since).count;}
 const historyPages=Math.max(1,Math.ceil(historyTotal/size)),historyPage=Math.min(filters.loginPage,historyPages);
 if(context.historyReady)history=db.prepare('SELECT id,action,status,ip,createdAt FROM accountLogins WHERE userId=? AND createdAt>=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?').all(userId,since,size,(historyPage-1)*size);
 return {updatedAt:new Date().toISOString(),filters,user,trend:trendRows(db,filters,context,userId),modelStats:modelRows(db,filters,context,userId),records,history,historyTotal,historyPage,historyPages,access:{ready:context.accessReady,historyReady:context.historyReady,retentionDays:90}};
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}
