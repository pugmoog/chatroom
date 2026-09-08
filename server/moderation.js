import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export const levels = [
  [],
  'ass arse bloody crap dammit damn damned hell jack-ass jackass'.split(' '),
  'arsehead arsehole asshole bastard bitch bollocks bugger bullshit dick dick-head dickhead dumb-ass dumbass horseshit piss prick pussy shit shite slut twat wanker'.split(' '),
  'cock fuck fucked fucker fucking goddammit goddamn goddamned goddamnit godsdamn'.split(' '),
  'brotherfucker child-fucker cocksucker cunt fatherfucker motherfucker pigfucker sisterfuck sisterfucker'.split(' '),
  'chigga dyke fag faggot kike nigga nigger spastic tranny'.split(' ')
];
const durations = [0, 60000, 600000, 3600000, 43200000, 172800000];
export function matches(text) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[‐‑‒–—]/g, '-');
  const words=levels.flat().sort((a,b)=>b.length-a.length);
  const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.join('|')})(?![\\p{L}\\p{N}_])`,'gu');
  return [...normalized.matchAll(pattern)].map(match=>({word:match[0],level:levels.findIndex(list=>list.includes(match[0]))}));
}

export function moderation(db, dataDir, apiError) {
  db.exec(`CREATE TABLE IF NOT EXISTS moderation_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    global_until INTEGER NOT NULL DEFAULT 0, chat_until INTEGER NOT NULL DEFAULT 0, personal_until INTEGER NOT NULL DEFAULT 0,
    level4 INTEGER NOT NULL DEFAULT 0, level5 INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS word_warnings (user_id TEXT REFERENCES users(id) ON DELETE CASCADE, word TEXT, PRIMARY KEY(user_id,word));
    CREATE TABLE IF NOT EXISTS user_ips (user_id TEXT REFERENCES users(id) ON DELETE CASCADE, ip TEXT, seen_at INTEGER, PRIMARY KEY(user_id,ip));
    CREATE TABLE IF NOT EXISTS chat_blocks (chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(chat_id,user_id));`);
  const sessions = new Map(), attempts = new Map();
  const cloudfront = new net.BlockList();
  try {
    const ranges=JSON.parse(fs.readFileSync(path.join(dataDir,'cloudfront-ranges.json'),'utf8'));
    for (const prefix of [...(ranges.prefixes||[]),...(ranges.ipv6_prefixes||[])]) if (prefix.service==='CLOUDFRONT') {
      const [ip,bits]=(prefix.ip_prefix||prefix.ipv6_prefix).split('/');cloudfront.addSubnet(ip,Number(bits),net.isIP(ip)===6?'ipv6':'ipv4');
    }
  } catch {}
  function status(id) {
    const row = db.prepare('SELECT * FROM moderation_state WHERE user_id=?').get(id) || {};
    return {serverNow: Date.now(), globalUntil: row.global_until || 0, chatUntil: row.chat_until || 0, personalUntil: row.personal_until || 0};
  }
  function recordIP(req, id) {
    // The portal appends its peer to CloudFront's viewer-appended XFF chain.
    // Enable only after the deployment's proxy chain has been verified.
    const hops = Number(process.env.CHAT_TRUSTED_PROXY_HOPS || 0);
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim());
    const edge=chain.at(-1);
    if (hops && (!net.isIP(edge||'') || !cloudfront.check(edge,net.isIP(edge)===6?'ipv6':'ipv4'))) return;
    const candidate = hops > 0 ? chain.at(-hops) : req.socket.remoteAddress;
    if (net.isIP(candidate || '') && !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(candidate)) {
      db.prepare('INSERT INTO user_ips VALUES(?,?,?) ON CONFLICT(user_id,ip) DO UPDATE SET seen_at=excluded.seen_at').run(id,candidate,Date.now());
      db.prepare('DELETE FROM user_ips WHERE user_id=? AND seen_at<?').run(id,Date.now()-60*86400000);
    }
  }
  function blocked(chatId, id) {
    if (db.prepare('SELECT 1 FROM chat_blocks WHERE chat_id=? AND user_id=?').get(chatId,id)) throw apiError(403,'The owner has blocked you from this chat.',{logout:true});
  }
  function enforce(id, channel, text, acknowledged = []) {
    const current = status(id);
    const until = Math.max(current.globalUntil, channel === 'chat' ? current.chatUntil : current.personalUntil);
    if (until > Date.now()) throw apiError(429,'Wait before sending another message.',{retryAfterMs:until-Date.now(),moderation:current});
    const found = matches(text);
    const unseen = found.filter((m,index) => found.findIndex(item=>item.word===m.word)===index && !db.prepare('SELECT 1 FROM word_warnings WHERE user_id=? AND word=?').get(id,m.word));
    if (unseen.some(m => !Array.isArray(acknowledged) || !acknowledged.includes(m.word))) {
      throw apiError(428,'Please review these words before sending.',{wordWarning:unseen,level:Math.max(0,...found.map(m=>m.level)),timeoutMs:durations[Math.max(0,...found.map(m=>m.level))]});
    }
    return found;
  }
  function apply(id, channel, found, charMs = 0) {
    const time = Date.now(), level = Math.max(0,...found.map(m=>m.level));
    db.prepare('INSERT OR IGNORE INTO moderation_state(user_id) VALUES(?)').run(id);
    db.prepare(`UPDATE moderation_state SET global_until=MAX(global_until,?), level4=level4+?, level5=level5+? WHERE user_id=?`).run(level ? time+durations[level] : 0,found.filter(m=>m.level===4).length,found.filter(m=>m.level===5).length,id);
    if (charMs) db.prepare(`UPDATE moderation_state SET ${channel === 'chat' ? 'chat_until' : 'personal_until'}=? WHERE user_id=?`).run(time+Math.ceil(charMs),id);
    for (const match of found) db.prepare('INSERT OR IGNORE INTO word_warnings VALUES(?,?)').run(id,match.word);
    return status(id);
  }
  function refuseSevere(id, channel, found) {
    if (found.some(m=>m.level===5)) {
      const updated = apply(id,channel,found);
      throw apiError(422,'This message was not sent. A two-day timeout now applies to chats and personal messages.',{moderation:updated,retryAfterMs:updated.globalUntil-Date.now()});
    }
  }
  async function admin(body) {
    const time = Date.now();
    for (const [key,value] of sessions) if (value < time) sessions.delete(key);
    if (typeof body.adminToken === 'string' && sessions.has(body.adminToken)) return;
    throw apiError(401,'Admin sign-in required.');
  }
  async function login(body, id) {
    const time = Date.now();
    for (const [key,value] of attempts) if (value.until < time) attempts.delete(key);
    const bucket = attempts.get(id) || {count:0,until:time+900000};
    const global = attempts.get('*') || {count:0,until:time+60000};
    if (bucket.count >= 5 || global.count >= 20) throw apiError(429,'Too many login attempts. Try again later.');
    bucket.count++; global.count++; attempts.set(id,bucket); attempts.set('*',global);
    let config;
    try {config=JSON.parse(fs.readFileSync(path.join(dataDir,'admin-password.json'),'utf8'));} catch {throw apiError(503,'Admin access is not configured.');}
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length > 256) throw apiError(401,'Incorrect passcode.');
    const digest = await new Promise((resolve,reject)=>crypto.scrypt(password,config.salt,32,(err,key)=>err?reject(err):resolve(key)));
    const expected = Buffer.from(config.hash,'hex');
    if (expected.length !== digest.length || !crypto.timingSafeEqual(expected,digest)) throw apiError(401,'Incorrect passcode.');
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,time+1800000);
    return {adminToken:token};
  }
  function users(body) {
    const q = String(body.query || '').slice(0,100).toLowerCase();
    const min = Math.max(0,Number(body.minCount)||0);
    return db.prepare(`SELECT u.id,u.display_name AS displayName,COALESCE(m.level4,0) AS level4,COALESCE(m.level5,0) AS level5 FROM users u LEFT JOIN moderation_state m ON m.user_id=u.id WHERE COALESCE(m.level4,0)+COALESCE(m.level5,0)>=? ORDER BY u.last_seen DESC`).all(min).map(u=>({...u,ips:db.prepare('SELECT ip,seen_at AS seenAt FROM user_ips WHERE user_id=? ORDER BY seen_at DESC').all(u.id)})).filter(u=>[u.id,u.displayName,...u.ips.map(i=>i.ip)].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,500);
  }
  return {status,recordIP,blocked,enforce,apply,refuseSevere,admin,login,users};
}
