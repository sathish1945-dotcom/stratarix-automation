import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const publicUser = row => row ? {id:row.id,name:row.name,email:row.email} : null;
const sessionDuration = 86400;
const cost = {N:32768,r:8,p:1,maxmem:64*1024*1024};
const dummySalt = randomBytes(16).toString('hex');

export async function makeServer({databasePath=process.env.DATABASE_PATH||resolve(root,'data','accounts.sqlite'),production=process.env.NODE_ENV==='production',origin=process.env.APP_ORIGIN||''}={}) {
 if(production && !/^https:\/\//.test(origin)) throw new Error('Production requires APP_ORIGIN set to the public HTTPS origin.');
 if(databasePath!==':memory:') await mkdir(dirname(resolve(databasePath)),{recursive:true,mode:0o700});
 const db=new DatabaseSync(databasePath);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);`);
 const limits = new Map();
 const prune=setInterval(()=>{const now=Date.now();for(const [key,value] of limits)if(value.until<now)limits.delete(key);db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);},60000);prune.unref();
 const assets=new Map();
 for(const [path,type] of [['index.html','text/html'],['app.js','text/javascript'],['style.css','text/css'],['favicon.svg','image/svg+xml']]) assets.set('/'+path,{type,body:await readFile(resolve(root,path))});
 const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
 if(production)headers['Strict-Transport-Security']='max-age=31536000';
 function send(res,status,data,extra={}){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(data));}
 function cookie(token,age=sessionDuration){return `stratarix_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${production?'; Secure':''}`;}
 function session(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('stratarix_session='))?.slice('stratarix_session='.length);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;return db.prepare('SELECT users.*, sessions.token_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now())||null;}
 function startSession(res,user){const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),user.id,Date.now()+sessionDuration*1000);send(res,200,{user:publicUser(user)},{'Set-Cookie':cookie(token)});}
 async function body(req){let content='';for await(const chunk of req){content+=chunk;if(Buffer.byteLength(content)>16384)throw Object.assign(new Error('Request too large.'),{status:413});}try{const data=JSON.parse(content);if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}catch{throw Object.assign(new Error('Invalid request.'),{status:400});}}
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(!url.pathname.startsWith('/api/')){if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed.'});const asset=assets.get(url.pathname==='/'?'/index.html':url.pathname);if(!asset)return send(res,404,{error:'Page not found.'});res.writeHead(200,{...headers,'Content-Type':asset.type+'; charset=utf-8','Cache-Control':'no-cache'});return res.end(req.method==='HEAD'?undefined:asset.body);}
   if(req.method==='GET'){
    if(url.pathname==='/api/config')return send(res,200,{authentication:true});
    if(url.pathname==='/api/me')return send(res,200,{user:publicUser(session(req))});
    return send(res,404,{error:'Endpoint not found.'});
   }
   if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
   const expectedOrigin=origin||`http://${req.headers.host}`;
   if(req.headers['x-stratarix-request']!=='1'||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==expectedOrigin))return send(res,403,{error:'Request origin is not allowed.'});
   if(!String(req.headers['content-type']).startsWith('application/json'))return send(res,415,{error:'Use a JSON request.'});
   if(!['/api/register','/api/login','/api/logout','/api/profile'].includes(url.pathname))return send(res,404,{error:'Endpoint not found.'});
   const key=`${req.socket.remoteAddress}:${['/api/login','/api/register'].includes(url.pathname)?'auth':'write'}`;
   let bucket=limits.get(key);if(!bucket||bucket.until<Date.now()){bucket={count:0,until:Date.now()+60000};limits.set(key,bucket);}if(++bucket.count>20)return send(res,429,{error:'Too many attempts. Wait a minute and try again.'},{'Retry-After':'60'});
   const data=await body(req);
   if(url.pathname==='/api/logout'){const current=session(req);if(current)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(current.token_hash);return send(res,200,{ok:true},{'Set-Cookie':cookie('',0)});}
   if(url.pathname==='/api/profile'){
    const current=session(req);if(!current)return send(res,401,{error:'Log in to update your profile.'});
    const name=typeof data.name==='string'?data.name.trim():'';if(name.length<2||name.length>80)return send(res,400,{error:'Your name must contain 2–80 characters.'});
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name,current.id);return send(res,200,{user:{...publicUser(current),name}});
   }
   const email=typeof data.email==='string'?data.email.trim().toLowerCase():'';
   const password=typeof data.password==='string'?data.password:'';
   if(email.length>254||!/^\S+@\S+\.\S+$/.test(email)||password.length<12||password.length>128)return send(res,400,{error:'Use a valid email and a password of 12–128 characters.'});
   if(url.pathname==='/api/register'){
    const name=typeof data.name==='string'?data.name.trim():'';if(name.length<2||name.length>80)return send(res,400,{error:'Your name must contain 2–80 characters.'});
    const salt=randomBytes(16).toString('hex');const passwordHash=(await scrypt(password,salt,64,cost)).toString('hex');
    let result;try{result=db.prepare('INSERT INTO users (name,email,salt,password_hash,created_at) VALUES (?,?,?,?,?)').run(name,email,salt,passwordHash,Date.now());}catch(err){if(err.code==='ERR_SQLITE_ERROR'&&String(err.message).includes('UNIQUE'))return send(res,409,{error:'An account with this email already exists. Please log in.'});throw err;}
    const old=session(req);if(old)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
    return startSession(res,{id:Number(result.lastInsertRowid),name,email});
   }
   const existing=db.prepare('SELECT * FROM users WHERE email=?').get(email);
   const candidate=await scrypt(password,existing?.salt||dummySalt,64,cost);
   const valid=timingSafeEqual(candidate,existing?Buffer.from(existing.password_hash,'hex'):Buffer.alloc(64));
   if(!existing||!valid)return send(res,401,{error:'The email or password is incorrect.'});
   const old=session(req);if(old)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
   return startSession(res,existing);
  }catch(err){if(!res.headersSent)send(res,err.status||500,{error:err.status?err.message:'Something went wrong. Please try again.'});else res.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 server.on('close',()=>{clearInterval(prune);db.close();});
 return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=await makeServer();
 const port=Number(process.env.PORT||3000);
 server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Stratarix is running at http://localhost:${port}`));
}
