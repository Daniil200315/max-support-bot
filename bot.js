import 'dotenv/config';
import { Bot, ImageAttachment, FileAttachment, VideoAttachment, AudioAttachment } from '@maxhub/max-bot-api';
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPPORT_CHAT_ID = Number(process.env.SUPPORT_CHAT_ID);

if (!BOT_TOKEN || !SUPPORT_CHAT_ID) {
  console.error('BOT_TOKEN and SUPPORT_CHAT_ID must be set in .env');
  process.exit(1);
}

// --- SQLite setup ---
mkdirSync('./data', { recursive: true });
const DB_PATH = './data/mapping.db';

const SQL = await initSqlJs();
const db = existsSync(DB_PATH)
  ? new SQL.Database(readFileSync(DB_PATH))
  : new SQL.Database();

db.run(`
  CREATE TABLE IF NOT EXISTS message_map (
    forwarded_mid TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    user_name     TEXT NOT NULL DEFAULT '',
    original_mid  TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// support_mid — mid сообщения сотрудника в чате поддержки
// client_mid  — mid сообщения, отправленного ботом клиенту
db.run(`
  CREATE TABLE IF NOT EXISTS reply_map (
    support_mid TEXT PRIMARY KEY,
    client_mid  TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

function saveDb() {
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbInsert(forwardedMid, userId, userName, originalMid) {
  db.run(
    'INSERT OR REPLACE INTO message_map (forwarded_mid, user_id, user_name, original_mid) VALUES (?, ?, ?, ?)',
    [forwardedMid, userId, userName, originalMid ?? null]
  );
  saveDb();
}

function dbGet(forwardedMid) {
  const stmt = db.prepare('SELECT user_id, user_name FROM message_map WHERE forwarded_mid = ?');
  stmt.bind([forwardedMid]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbInsertReply(supportMid, clientMid) {
  db.run(
    'INSERT OR REPLACE INTO reply_map (support_mid, client_mid) VALUES (?, ?)',
    [supportMid, clientMid]
  );
  saveDb();
}

function dbGetReply(supportMid) {
  const stmt = db.prepare('SELECT client_mid FROM reply_map WHERE support_mid = ?');
  stmt.bind([supportMid]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbGetByOriginalMid(originalMid) {
  const stmt = db.prepare('SELECT forwarded_mid, user_id, user_name FROM message_map WHERE original_mid = ?');
  stmt.bind([originalMid]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbClean() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  db.run('DELETE FROM message_map WHERE created_at < ?', [cutoff]);
  db.run('DELETE FROM reply_map WHERE created_at < ?', [cutoff]);
  if (db.getRowsModified() > 0) saveDb();
}

// Очистка старых записей при старте
dbClean();

// --- Bot setup ---
const bot = new Bot(BOT_TOKEN);
let botUserId = null;

async function initBotId() {
  const info = await bot.api.raw.get('me', {});
  botUserId = info.user_id;
  console.log(`Bot started: id=${botUserId} name=${info.name}`);
}

// --- Helpers ---

function buildAttachments(attachments) {
  if (!attachments?.length) return [];
  const result = [];
  for (const att of attachments) {
    const token = att.payload?.token ?? att.token;
    if (!token) continue;
    switch (att.type) {
      case 'image': result.push(new ImageAttachment({ token }).toJson()); break;
      case 'file':  result.push(new FileAttachment({ token }).toJson());  break;
      case 'video': result.push(new VideoAttachment({ token }).toJson()); break;
      case 'audio': result.push(new AudioAttachment({ token }).toJson()); break;
    }
  }
  return result;
}

function getChatId(ctx) {
  return (
    ctx.message?.recipient?.chat_id ??
    ctx.message?.recipient?.chatId ??
    ctx.chatId ??
    ctx.chat?.chat_id ??
    null
  );
}

// --- Handlers ---

bot.command('start', async (ctx) => {
  await ctx.reply('Здравствуйте!\nНапишите Ваш вопрос и мы ответим в ближайшее время.');
});

bot.on('bot_started', async (ctx) => {
  await ctx.reply('Здравствуйте!\nНапишите Ваш вопрос и мы ответим в ближайшее время.');
});

bot.on('message_edited', async (ctx) => {
  const chatId = getChatId(ctx);
  if (String(chatId) === String(SUPPORT_CHAT_ID)) {
    await handleSupportMessageEdit(ctx);
  } else {
    await handleClientMessageEdit(ctx);
  }
});

async function handleSupportMessageEdit(ctx) {
  const supportMid = ctx.message?.body?.mid;
  if (!supportMid) return;

  const mapping = dbGetReply(supportMid);
  if (!mapping) return;

  const body = ctx.message.body;
  const attachments = buildAttachments(body.attachments);
  const editBody = { text: body.text ?? '' };
  if (attachments.length) editBody.attachments = attachments;

  try {
    const res = await fetch(
      `https://platform-api.max.ru/messages?message_id=${mapping.client_mid}`,
      {
        method: 'PUT',
        headers: { 'Authorization': BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(editBody),
      }
    );
    if (!res.ok) console.error(`Edit failed (${res.status}):`, await res.text());
    else console.log(`Edited client message ${mapping.client_mid}`);
  } catch (e) {
    console.error('Error editing client message:', e.message);
  }
}

async function handleClientMessageEdit(ctx) {
  const body = ctx.message.body;
  const mapping = dbGetByOriginalMid(body.mid);
  if (!mapping) return;

  const sender = ctx.message.sender;
  const userName = sender.name ?? sender.username ?? `ID ${sender.user_id}`;
  const attachments = buildAttachments(body.attachments);
  const editBody = {
    text: `✏️ ${userName} (ID: ${sender.user_id}) изменил сообщение:\n${body.text ?? ''}`,
  };
  if (attachments.length) editBody.attachments = attachments;

  try {
    const res = await fetch(
      `https://platform-api.max.ru/messages?message_id=${mapping.forwarded_mid}`,
      {
        method: 'PUT',
        headers: { 'Authorization': BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(editBody),
      }
    );
    if (!res.ok) console.error(`Edit forwarded failed (${res.status}):`, await res.text());
    else console.log(`Edited forwarded message ${mapping.forwarded_mid}`);
  } catch (e) {
    console.error('Error editing forwarded message:', e.message);
  }
}

bot.on('message_created', async (ctx) => {
  console.log('=== DEBUG ===');
  console.log('recipient:', JSON.stringify(ctx.message?.recipient, null, 2));
  console.log('sender:   ', JSON.stringify(ctx.message?.sender, null, 2));
  console.log('link:     ', JSON.stringify(ctx.message?.link, null, 2));
  console.log('body.mid: ', ctx.message?.body?.mid);
  console.log('=============');

  const senderId = ctx.message?.sender?.user_id;
  if (botUserId && senderId === botUserId) return;

  const chatId = getChatId(ctx);
  const isFromSupportChat = String(chatId) === String(SUPPORT_CHAT_ID);

  if (isFromSupportChat) {
    await handleSupportReply(ctx);
  } else {
    await handleClientMessage(ctx);
  }
});

async function handleClientMessage(ctx) {
  const sender = ctx.message.sender;
  const body = ctx.message.body;
  const userName = sender.name ?? sender.username ?? `ID ${sender.user_id}`;
  const originalMid = body.mid;

  const text = `📩 ${userName} (ID: ${sender.user_id}):\n${body.text ?? ''}`;
  const attachments = buildAttachments(body.attachments);

  try {
    const sent = await ctx.api.sendMessageToChat(
      SUPPORT_CHAT_ID,
      text,
      attachments.length ? { attachments } : {}
    );

    const forwardedMid = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.mid;
    if (!forwardedMid) {
      console.error('Could not extract mid from sent message:', JSON.stringify(sent));
      return;
    }

    dbInsert(forwardedMid, sender.user_id, userName, originalMid);
    console.log(`Forwarded client ${sender.user_id} → support chat, mid=${forwardedMid}`);
  } catch (e) {
    console.error('Error forwarding to support chat:', e.message);
  }
}

async function handleSupportReply(ctx) {
  const link = ctx.message.link;
  if (!link || link.type !== 'reply') return;

  const repliedMid = link.message?.body?.mid ?? link.message?.mid ?? null;
  if (!repliedMid) {
    console.warn('reply link found but mid is missing:', JSON.stringify(link));
    return;
  }

  const mapping = dbGet(repliedMid);
  if (!mapping) return;

  const body = ctx.message.body;
  const text = body.text ?? '';
  const attachments = buildAttachments(body.attachments);

  try {
    const sent = await ctx.api.sendMessageToUser(
      mapping.user_id,
      text,
      attachments.length ? { attachments } : {}
    );

    // Сохраняем маппинг для последующего редактирования
    const clientMid = sent?.message?.body?.mid ?? sent?.body?.mid ?? sent?.mid;
    const supportMid = ctx.message.body.mid;
    if (clientMid && supportMid) {
      dbInsertReply(supportMid, clientMid);
    }

    console.log(`Sent support reply → client ${mapping.user_id} (${mapping.user_name})`);
  } catch (e) {
    console.error('Error sending reply to client:', e.message);
  }
}

// --- Start ---
await initBotId();
bot.start().catch((e) => {
  console.error('Fatal polling error:', e.message);
  process.exit(1);
});
console.log('Long polling started');
