// index.js
import express   from 'express';
import qrcode    from 'qrcode-terminal';
import 'dotenv/config';

import { initSession, getSocket } from './session.js';
import { startScheduler }         from './scheduler.js';
import { handleCommand }          from './commands.js';
import { checkAntiLink, checkAntiVulgar } from './anti.js';
import { normalizeJid }           from './utils.js';
import { isAdmin, isBotAdmin }    from './auth.js';
import { Boom }                   from '@hapi/boom';
import { clearSession }           from './db.js';

const app = express();
let isConnected       = false;
let reconnectAttempts = 0;
let schedulerStarted  = false; // ✅ FIX: guard so startScheduler never fires twice

const MAX_RECONNECT_ATTEMPTS  = 12;
const BASE_RECONNECT_DELAY_MS = 10_000;

// ────────────────────────────────────────────────
// Web routes
// ────────────────────────────────────────────────

app.get('/', (req, res) => {
  const sock = getSocket();
  if (isConnected) {
    res.send('<h1>✅ WhatsApp Bot is Connected</h1>');
  } else if (sock?.qrString) {
    // ✅ FIX: JSON.stringify escapes all special characters in the QR string so the
    //         embedded JS literal is always valid (old code could break on backslashes).
    const safeQr = JSON.stringify(sock.qrString);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>WhatsApp Bot — Scan QR</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>Scan QR to Link WhatsApp</h1>
        <div id="qrcode" style="display:inline-block"></div>
        <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
        <script>
          const qr = ${safeQr};
          const canvas = document.createElement('canvas');
          QRCode.toCanvas(canvas, qr, { width: 300 }, (err) => {
            if (!err) document.getElementById('qrcode').appendChild(canvas);
          });
        </script>
      </body>
      </html>
    `);
  } else {
    res.send('<h1>⏳ Bot is starting — no QR code yet. Refresh in a few seconds.</h1>');
  }
});

app.get('/health', (req, res) => {
  res.json({
    status:           isConnected ? 'connected' : 'disconnected',
    uptimeSeconds:    Math.floor(process.uptime()),
    reconnectAttempts,
    schedulerStarted,
    qrActive:         !!getSocket()?.qrString && !isConnected,
    timestamp:        new Date().toISOString(),
  });
});

// ────────────────────────────────────────────────
// Bot lifecycle
// ────────────────────────────────────────────────

async function startBot() {
  try {
    console.log('🔄 Starting WhatsApp connection attempt...');
    const sock = await initSession();

    // ── Incoming messages ─────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // ✅ FIX: 'notify' = real-time message; 'append' = history sync — only handle notify
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg?.message)  return; // ✅ FIX: guard against empty message objects
      if (msg.key.fromMe) return; // ✅ FIX: ignore messages sent by the bot itself

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid)     return;

      // ✅ FIX: properly distinguish group chats from DMs
      const isGroup = remoteJid.endsWith('@g.us');

      // ✅ FIX: group messages carry the real sender in key.participant,
      //         DM messages use remoteJid as the sender
      const senderJid = normalizeJid(
        isGroup ? (msg.key.participant || remoteJid) : remoteJid
      );

      const text = (
        msg.message?.conversation              ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption     ||
        msg.message?.videoMessage?.caption     ||
        ''
      ).trim();

      if (isGroup) {
        // ── Group-specific path ─────────────────────────────────
        // ✅ FIX: isBotAdmin was previously called for DMs too, which
        //         would error or silently drop all DM messages
        const botIsAdmin = await isBotAdmin(sock, remoteJid);
        if (!botIsAdmin) return;

        const isAdminFlag = await isAdmin(sock, remoteJid, senderJid);

        // Moderation runs for everyone (admins are exempt inside these functions)
        await checkAntiLink  (text, isAdminFlag, remoteJid, senderJid, sock);
        await checkAntiVulgar(msg,  isAdminFlag, remoteJid, senderJid, sock);

        // Group commands only for admins
        if (isAdminFlag) {
          await handleCommand(sock, msg);
        }
      } else {
        // ── DM path ─────────────────────────────────────────────
        // ✅ FIX: DM commands now always reach handleCommand;
        //         no admin check needed for personal chats
        await handleCommand(sock, msg);
      }
    });

    // ── Connection state ──────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sock.qrString = qr;
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        console.log('🎉 Connected to WhatsApp');
        isConnected       = true;
        reconnectAttempts = 0;
        // ✅ FIX: scheduler was re-started on every reconnect, creating duplicate jobs
        if (!schedulerStarted) {
          schedulerStarted = true;
          startScheduler();
        }
      }

      if (connection === 'close') {
        isConnected = false;

        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : (lastDisconnect?.error?.statusCode ?? 'unknown');

        console.warn(`⚠️  Connection closed (code: ${statusCode})`);

        if (statusCode === 401) {
          // ✅ FIX: 401 = logged out — clear the stored session so the next
          //         start creates a fresh one, but do NOT auto-reconnect
          //         (there is no valid session to reconnect to)
          console.error('❌ Logged out from WhatsApp. Clearing session...');
          try {
            await clearSession();
            console.log('🗑  Session cleared. Restart the process to re-authenticate.');
          } catch (e) {
            console.error('Failed to clear session:', e.message);
          }
          return; // ✅ FIX: was falling through to handleReconnect() before
        }

        // Any other disconnect is transient — schedule a retry
        console.log('🔄 Transient disconnect — scheduling reconnect...');
        handleReconnect();
      }
    });

  } catch (err) {
    console.error('❌ Failed to start bot:', err.message || err);
    handleReconnect();
  }
}

function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`🛑 Reached max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}). Giving up.`);
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * (1.6 ** (reconnectAttempts - 1)),
    600_000  // cap at 10 minutes
  );
  console.log(`🔁 Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
  setTimeout(startBot, delay);
}

// ────────────────────────────────────────────────
// Shutdown & error handling
// ────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\nSIGINT received — shutting down gracefully');
  const sock = getSocket();
  if (sock) {
    try { await sock.logout(); }
    catch (e) { console.error('Logout failed:', e.message); }
  }
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  isConnected = false;
  handleReconnect();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
startBot();
