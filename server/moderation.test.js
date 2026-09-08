import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {moderation,matches} from './moderation.js';
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO users VALUES('one'),('two');");
  const error=(status,message,extra={})=>Object.assign(new Error(message),{status,...extra});
  return {db,mod:moderation(db,'/tmp/nonexistent-admin-config',error),error};
}
test('whole words, capitalization, hyphens, and strongest matching',()=>{
  assert.equal(matches('class assignment hello Dickinson').length,0);
  assert.equal(matches('GODDAMN')[0].level,3);
  assert.equal(matches('jack‑ass')[0].word,'jack-ass');
  assert.equal(Math.max(...matches('fuck nigger').map(m=>m.level)),5);
});
test('warnings must be acknowledged once per identity, then persist',()=>{
  const {db,mod,error}=setup();
  assert.throws(()=>mod.enforce('one','chat','damn'),e=>e.status===428 && e.wordWarning[0].word==='damn');
  assert.equal(mod.status('one').globalUntil,0);
  const found=mod.enforce('one','chat','damn',['damn']);mod.apply('one','chat',found,1000);
  assert.throws(()=>mod.enforce('one','personal','hello'),e=>e.status===429);
  db.prepare('UPDATE moderation_state SET global_until=0,chat_until=0').run();
  const restarted=moderation(db,'/tmp/nonexistent-admin-config',error);
  assert.equal(restarted.enforce('one','chat','damn').length,1);
  assert.throws(()=>restarted.enforce('two','chat','damn'),e=>e.status===428);
});
test('level five refused, maximum not sum, persists across module recreation',()=>{
  const {db,mod,error}=setup();
  const found=mod.enforce('one','personal','fuck nigger',['fuck','nigger']);
  const start=Date.now();
  assert.throws(()=>mod.refuseSevere('one','personal',found),e=>e.status===422);
  const restarted=moderation(db,'/tmp/nonexistent-admin-config',error);
  assert.ok(restarted.status('one').globalUntil-start<=172801000);
  assert.ok(restarted.status('one').globalUntil-start>=172800000);
  assert.throws(()=>restarted.enforce('one','chat','hello'),e=>e.status===429);
  assert.equal(db.prepare('SELECT level5 FROM moderation_state').get().level5,1);
});
test('long character cooldown wins in its channel; global remains independent',()=>{
  const {mod}=setup();
  mod.apply('one','personal',[{word:'damn',level:1}],1287000);
  const s=mod.status('one');assert.ok(s.personalUntil>s.globalUntil);
  assert.equal(s.chatUntil,0);
  mod.apply('two','chat',[],20000);
  assert.deepEqual(mod.enforce('two','personal','hello'),[]);
});
test('unauthorized admin requests fail',async()=>{
  const {mod}=setup();await assert.rejects(mod.admin({adminToken:'fake'}),e=>e.status===401);
});
