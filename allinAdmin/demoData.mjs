export function createDemo() {
 const now=Date.now(); const ago=h=>new Date(now-h*3600000).toISOString();
 const projects=[
 {id:'pr01',name:'长安夜行录',owner:'第一制作组',episodes:12,completedEpisodes:8,stage:'视频生成',budget:6000,dueAt:ago(-72)},
 {id:'pr02',name:'星海拾光',owner:'第二制作组',episodes:16,completedEpisodes:5,stage:'分镜绘制',budget:8000,dueAt:ago(-144)},
 {id:'pr03',name:'今天也要做掌门',owner:'第一制作组',episodes:8,completedEpisodes:8,stage:'已交付',budget:4000,dueAt:ago(12)},
 {id:'pr04',name:'山月不知心底事',owner:'第三制作组',episodes:10,completedEpisodes:2,stage:'配音制作',budget:5000,dueAt:ago(24)},
 {id:'pr05',name:'末日便利店',owner:'第二制作组',episodes:20,completedEpisodes:0,stage:'剧本创作',budget:12000,dueAt:ago(-240)}];
 const models=[{id:'m01',name:'图像模型 A',provider:'示例图像服务',type:'图片'},{id:'m02',name:'视频模型 B',provider:'示例视频服务',type:'视频'},{id:'m03',name:'语音模型 C',provider:'示例语音服务',type:'配音'},{id:'m04',name:'文本模型 D',provider:'示例文本服务',type:'剧本'}];
 const states=['succeeded','succeeded','failed','running','succeeded','queued','succeeded','succeeded'];
 const tasks=Array.from({length:96},(_,i)=>{const p=projects[i%5],m=models[i%4],status=states[i%8];return {id:'tsk'+String(i+1).padStart(4,'0'),projectId:p.id,episode:1+i%p.episodes,shot:1+i%24,modelId:m.id,type:m.type,status,createdAt:ago(i*1.7),durationMs:['running','queued'].includes(status)?null:18000+i*2300,cost:status==='queued'?0:Math.round((m.type==='视频'?8.4:m.type==='图片'?0.6:0.18)*(1+i%5)*100)/100,costConfirmed:i%3!==0,review:status==='succeeded'?(i%7===0?'rejected':i%3===0?'pending':'approved'):'pending',error:status==='failed'?'上游请求超时（示例）':'',retries:status==='failed'?2:0};});
 return {schemaVersion:1,source:'demo',updatedAt:new Date().toISOString(),projects,models,tasks,alerts:[{id:'al01',severity:'critical',title:'视频服务连续请求超时',detail:'演示告警：请检查服务商可用性与配额。',projectId:'pr03',createdAt:ago(0.3),status:'open'},{id:'al02',severity:'warning',title:'项目交付时间已到',detail:'山月不知心底事尚未完成交付。',projectId:'pr04',createdAt:ago(2),status:'open'}]};
}
