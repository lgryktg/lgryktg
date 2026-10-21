import {isIP} from 'node:net';
import {readFileSync,existsSync} from 'node:fs';
const locationRoot=existsSync(new URL('./data/ipLocation/source.json',import.meta.url))?'./data/ipLocation/':'./resources/ipLocation/';
import {IPv4,IPv6,verifyFromFile,loadContentFromFile,newWithBuffer,parseIP} from './vendor/ip2region/index.js';
const readers=new Map();
let source={provider:'ip2region',offline:true};
try{source={...source,...JSON.parse(readFileSync(new URL('./data/ipLocation/source.json',import.meta.url),'utf8'))};}catch{}
for(const [version,kind] of [[4,IPv4],[6,IPv6]]){try{const file=new URL(locationRoot+'v'+version+'.xdb',import.meta.url);verifyFromFile(file);readers.set(version,newWithBuffer(kind,loadContentFromFile(file)));}catch(error){console.error('IP 城市库不可用 IPv'+version,error.message);}}
const result=(status,label,extra={})=>({status,label,...extra});
export async function locateIp(value){
 if(!value)return result('missing','尚未记录');
 let ip=String(value).replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i,'$1');
 const version=isIP(ip);if(!version)return result('invalid','地址无效');
 const bytes=parseIP(ip);
 if(version===6&&bytes.subarray(0,10).every(v=>v===0)&&bytes[10]===255&&bytes[11]===255)return locateIp([...bytes.subarray(12)].join('.'));
 if(version===4){const [a,b,c]=bytes;
 if(a===127)return result('local','本机回环地址');
 if(a===10||a===172&&b>=16&&b<=31||a===192&&b===168||a===169&&b===254)return result('private','内网 / 本地地址');
 if(a===100&&b>=64&&b<=127)return result('shared','运营商共享地址');
 if(a===0||a>=224||a===192&&b===0||a===192&&b===2||a===198&&(b===18||b===19)||a===198&&b===51&&c===100||a===203&&b===0&&c===113)return result('special','保留 / 特殊用途地址');
 }else{
 if(bytes.every(v=>v===0))return result('special','未指定地址');
 if(bytes.subarray(0,15).every(v=>v===0)&&bytes[15]===1)return result('local','本机回环地址');
 if((bytes[0]&254)===252||bytes[0]===254&&(bytes[1]&192)===128)return result('private','内网 / 本地地址');
 if((bytes[0]&224)!==32||bytes[0]===32&&bytes[1]===1&&bytes[2]===13&&bytes[3]===184)return result('special','保留 / 特殊用途地址');
 }
 const reader=readers.get(version);if(!reader)return result('unavailable','城市库不可用');
 try{const region=await reader.search(ip);const clean=v=>v&&v!=='0'?v:null;const [country,province,city,isp,countryCode]=region.split('|').map(clean);const parts=[...new Set([country,province,city].filter(Boolean))];return parts.length?result(city?'located':'regionOnly',parts.join(' · '),{country,province,city,isp,countryCode}):result('unknown','暂无归属地');}catch{return result('unknown','暂无归属地');}
}
export async function enrichUserLocations(data){
 const rows=data.users||[data.user];
 await Promise.all(rows.filter(Boolean).map(async user=>{[user.registeredLocation,user.lastLoginLocation]=await Promise.all([locateIp(user.registeredIp),locateIp(user.lastLoginIp)]);}));
 await Promise.all((data.history||[]).map(async row=>{row.location=await locateIp(row.ip);}));
 data.ipLocation={...source,ipv4Ready:readers.has(4),ipv6Ready:readers.has(6),approximate:true};return data;
}
