import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeServer} from './server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

test('account lifecycle, session protection, input handling and static assets',async()=>{
 const server=await makeServer({databasePath:':memory:'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 let cookie='';
 async function post(path,data,extra={}){return fetch(`${origin}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Stratarix-Request':'1',Origin:origin,Cookie:cookie,...extra},body:JSON.stringify(data)});}
 try{
  assert.equal((await fetch(origin)).status,200);
  assert.equal((await fetch(origin+'/server.mjs')).status,404);
  assert.equal((await fetch(origin+'/data/accounts.sqlite')).status,404);
  assert.equal((await fetch(origin+'/api/me').then(r=>r.json())).user,null);
  assert.equal((await post('profile',{name:'Another name'})).status,401);
  assert.equal((await post('register',{name:'QA Client',email:'qa@example.test',password:'short'})).status,400);
  assert.equal((await post('register',{name:'QA Client',email:'qa@example.test',password:'Test-only-long-password-123'},{Origin:'https://evil.example'})).status,403);
  let response=await post('register',{name:'QA Client',email:'QA@example.test',password:'Test-only-long-password-123'});
  assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  let result=await response.json();assert.equal(result.user.email,'qa@example.test');assert.deepEqual(Object.keys(result.user).sort(),['email','id','name']);
  assert.equal((await post('register',{name:'QA Client',email:'qa@example.test',password:'Test-only-long-password-123'})).status,409);
  response=await post('profile',{name:'Updated client'});assert.equal((await response.json()).user.name,'Updated client');
  assert.equal((await post('profile',{name:'Should fail'},{'X-Stratarix-Request':''})).status,403);
  const oldCookie=cookie;assert.equal((await post('logout',{})).status,200);
  assert.equal((await fetch(origin+'/api/me',{headers:{Cookie:oldCookie}}).then(r=>r.json())).user,null);
  assert.equal((await post('login',{email:'qa@example.test',password:'Wrong-password-long-123'})).status,401);
  response=await post('login',{email:'qa@example.test',password:'Test-only-long-password-123'});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin+'/api/me',{headers:{Cookie:cookie}}).then(r=>r.json())).user.name,'Updated client');
  response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Stratarix-Request':'1',Origin:origin},body:'{broken'});assert.equal(response.status,400);
  for(let i=0;i<20;i++)response=await post('login',{email:'bad',password:''});assert.equal(response.status,429);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('accounts survive restart, passwords are hashed, and sessions expire',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stratarix-test-'));
 const databasePath=join(directory,'accounts.sqlite');
 let server=await makeServer({databasePath});
 const listen=async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;};
 const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 try{
  let origin=await listen();
  let response=await fetch(origin+'/api/register',{method:'POST',headers:{'Content-Type':'application/json','X-Stratarix-Request':'1',Origin:origin},body:JSON.stringify({name:'Persistent Client',email:'persist@example.test',password:'Testing-persistence-123'})});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];
  await close();
  const database=new DatabaseSync(databasePath);const row=database.prepare('SELECT * FROM users').get();
  assert.notEqual(row.password_hash,'Testing-persistence-123');assert.equal(row.password_hash.length,128);assert.equal(row.salt.length,32);
  database.prepare('UPDATE sessions SET expires_at=0').run();database.close();
  server=await makeServer({databasePath});origin=await listen();
  assert.equal((await fetch(origin+'/api/me',{headers:{Cookie:cookie}}).then(r=>r.json())).user,null);
  response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Stratarix-Request':'1',Origin:origin},body:JSON.stringify({email:'persist@example.test',password:'Testing-persistence-123'})});
  assert.equal(response.status,200);assert.equal((await response.json()).user.name,'Persistent Client');
 }finally{if(server.listening)await close();await rm(directory,{recursive:true,force:true});}
});
