const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type');
const { sms, downloadMediaMessage } = require("./lib/msg");
const { fetchJson } = require("./lib/function");
const { askDeepSeek } = require("./lib/scraper");
const ai = require('ai-apis');

// commands/movie.js file load karvama aave chhe
const registerMovieCommands = require('./commands/movie');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

// Process ne crash thava n do
if (!process.__maleeyaGuards) {
    process.__maleeyaGuards = true;
    process.on('unhandledRejection', (reason) => {
        console.error('⚠️ Unhandled Rejection:', reason && reason.message ? reason.message : reason);
    });
    process.on('uncaughtException', (err) => {
        console.error('⚠️ Uncaught Exception:', err && err.stack ? err.stack : err);
    });
}

const FIREBASE_URL = 'https://maleeya-v3-default-rtdb.asia-southeast1.firebasedatabase.app/';

const config = {
    BOT_NAME: '👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽 🍟',
    BOT_FOOTER: '🤖 ᴄʀᴇᴀᴛᴇ ʙʏ ᴍᴀʟᴇᴇꜱʜᴀ 👻',
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://whatsapp.com/channel/0029Vb8x1Ww05MUln6ux1S3g',
    RCD_IMAGE_PATH: 'https://cloud.laksidu.site/stream/id9Z5k2DKm/lakiya-1791452706674.jpg',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94761602391',
    ADMIN_LIST_PATH: './lib/admin.json',
    NEWSLETTER_JID: '120363412993089485@newsletter',
    // Chamindu API Keys Array (Limit thaya pachi auto next key par switch thase)
    CHAMINDU_API_KEYS: [
        'chama_api_3c15ae06aa01956a74e89c68a5d59a91',
        'kcey_df60f2feb1dba64623a31f73aca1d29c309b'
    ],
    SUPUN_API_KEY: 'supun-4apwzn10apu3tf0uk41bimnq'
};

// Chamindu API fallback helper function
async function fetchChaminduApi(endpointPath, customParams = {}, timeoutMs = 30000) {
    const API_BASE = "https://api.chamindu.site";
    let lastError = null;

    for (let i = 0; i < config.CHAMINDU_API_KEYS.length; i++) {
        const apiKey = config.CHAMINDU_API_KEYS[i];
        try {
            const url = `${API_BASE}${endpointPath}`;
            const params = { ...customParams, api_key: apiKey };
            
            const response = await axios.get(url, { params, timeout: timeoutMs });
            return response;
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            console.warn(`⚠️ Chamindu API Key [Index ${i}] failed with status: ${status || err.message}. Trying next key...`);
        }
    }
    throw lastError || new Error("All Chamindu API Keys failed or reached their limit.");
}

const MOVIE_CMDS = [
    'baiscope', 'bs', 'lksub', 'ls', 'sinhalasub', 'ss', 'thenkiri', 'tk',
    'cinesubz', 'cine', 'cs', 'cineru', 'cr', 'dinkamovies', 'dm',
    'sinhalacartoons', 'sc', 'chithrapata', 'cp', 'animeheaven', 'ah',
    'subtitle', 'subcat', 'sub'
];

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

const RECONNECT_BASE_MS = 3 * 1000;
const RECONNECT_MAX_MS = 30 * 1000;
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_401_BEFORE_DELETE = 5;
const lastAutoReconnectAttempt = new Map();
const pendingAutoReconnect = new Map();
const reconnectFailures = new Map();
const loggedOutCount = new Map();
const restartingNumbers = new Set();
const adminNotified = new Set();
const initializingNumbers = new Set();
const staleStrikes = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function makeMockRes() {
    const r = { headersSent: false, send: () => {}, status: () => r };
    return r;
}

function scheduleAutoReconnect(number, fn, delayMs = RECONNECT_BASE_MS) {
    const cleanNumber = number.replace(/[^0-9]/g, '');
    if (pendingAutoReconnect.has(cleanNumber)) {
        return;
    }
    console.log(`Auto-reconnect for ${cleanNumber} in ${Math.ceil(delayMs / 1000)}s`);
    pendingAutoReconnect.set(cleanNumber, setTimeout(() => {
        pendingAutoReconnect.delete(cleanNumber);
        lastAutoReconnectAttempt.set(cleanNumber, Date.now());
        fn();
    }, delayMs));
}

function loadAdmins() {
    try {
        let admins = [];
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            admins = JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        if (!Array.isArray(admins)) admins = [];
        
        if (config.OWNER_NUMBER && !admins.includes(config.OWNER_NUMBER)) {
            admins.push(config.OWNER_NUMBER);
        }
        return admins;
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [config.OWNER_NUMBER];
    }
}

async function sendAdminConnectMessage(socket, number) {
    const userNumber = String(number).replace(/[^0-9]/g, '');
    const admins = [...new Set([...loadAdmins().map(a => String(a).replace(/[^0-9]/g, '')), userNumber])];
    const date = moment().tz("Asia/Colombo").format("YYYY-MM-DD");
    const time = moment().tz("Asia/Colombo").format("HH:mm:ss");

    const connectMessage = `👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽

✨ Bot activated & 24/7 Active ✅

⏰ Time: ${time}
📅 Date: ${date}
📱 Number: +${number}

🤖 ᴄʀᴇᴀᴛᴇ ʙʏ ᴍᴀʟᴇᴇꜱʜᴀ 👻`;

    for (const admin of admins) {
        try {
            const adminJid = `${String(admin).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            await socket.sendMessage(
                adminJid,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: connectMessage
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error.message || error);
        }
    }
}

async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
        }

        const pathsToDelete = [
            `session/creds_${sanitizedNumber}`,
            `numbers/${sanitizedNumber}`
        ];
        for (const p of pathsToDelete) {
            try {
                await axios.delete(`${FIREBASE_URL}/${p}.json`);
            } catch (e) {}
        }

        try {
            const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let numbers = numbersRes.data || [];
            if (!Array.isArray(numbers)) numbers = [];
            numbers = numbers.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        } catch (e) {}

        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch (e) {}
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
        }
    } catch (err) {
        console.error(`❌ Failed to fully delete session:`, err.message);
    }
}

function setupAutoRestart(socket, number) {
    const cleanNumber = number.replace(/[^0-9]/g, '');

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            reconnectFailures.delete(cleanNumber);
            loggedOutCount.delete(cleanNumber);
            staleStrikes.delete(cleanNumber);
            console.log(`Connection opened successfully for ${cleanNumber}`);
            if (!adminNotified.has(cleanNumber)) {
                adminNotified.add(cleanNumber);
                await sendAdminConnectMessage(socket, cleanNumber);
            }
            return;
        }

        if (connection !== 'close') return;

        if (restartingNumbers.has(cleanNumber)) return;
        if (activeSockets.get(cleanNumber) !== socket) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔄 Connection closed for ${cleanNumber}. Status code: ${statusCode}`);
        
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);

        if (statusCode === 401) {
            const n = (loggedOutCount.get(cleanNumber) || 0) + 1;
            loggedOutCount.set(cleanNumber, n);
            if (n >= MAX_401_BEFORE_DELETE) {
                console.log(`⚠️ Logged out (401) x${n} for ${cleanNumber}. Deleting session.`);
                loggedOutCount.delete(cleanNumber);
                reconnectFailures.delete(cleanNumber);
                await fullDeleteSession(cleanNumber);
                return;
            }
            console.log(`⚠️ 401 (${n}/${MAX_401_BEFORE_DELETE}) for ${cleanNumber}. Reconnecting...`);
        }

        let delayMs;
        if (statusCode === 440) {
            delayMs = 10 * 1000;
            console.log(`⚠️ Connection replaced (440) for ${cleanNumber}. Reconnecting...`);
        } else {
            const fails = (reconnectFailures.get(cleanNumber) || 0) + 1;
            reconnectFailures.set(cleanNumber, fails);
            delayMs = Math.min(RECONNECT_BASE_MS * Math.pow(1.5, fails - 1), RECONNECT_MAX_MS);
        }

        scheduleAutoReconnect(cleanNumber, async () => {
            await EmpirePair(cleanNumber, makeMockRes());
        }, delayMs);
    });
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => { try {
        const msg = messages[0];
        if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;	
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const m = sms(socket, msg);
        
        let body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';

        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const pushname = msg.pushName || 'Name';
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        let prefix = config.PREFIX;
        let isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;

        const supunmdq = { 
            key: { 
                remoteJid: "status@broadcast", 
                fromMe: false, id: 'FAKE_META_ID_001', 
                participant: '13135550002@s.whatsapp.net' 
            }, 
            message: { 
                contactMessage: { 
                    displayName: '👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽🍟', 
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Alip;;;;\nFN:Alip\nTEL;waid=13135550002:+1 313 555 0002\nEND:VCARD` 
                } 
            } 
        };

        const reply = async (teks) => {
            return await socket.sendMessage(from, { text: teks }, { quoted: supunmdq });
        };

        const MENU_IMAGE_URL = config.RCD_IMAGE_PATH || 'https://cloud.laksidu.site/stream/id9Z5k2DKm/lakiya-1791452706674.jpg';
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedCaption = quotedMsg?.imageMessage?.caption || quotedMsg?.videoMessage?.caption || quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || (m.quoted ? (m.quoted.text || m.quoted.caption || '') : '');
        const cleanBody = body.trim();

        if (quotedMsg && /^\d+$/.test(cleanBody)) {
            if (quotedCaption.includes('MALIYA CINEMA') || quotedCaption.includes('REPLY WITH NUMBER') || quotedCaption.includes('STATUS PANEL') || quotedCaption.includes('SEARCH MENU')) {
                const currentDate = moment().tz("Asia/Colombo").format("YYYY/M/D");
                const currentTime = moment().tz("Asia/Colombo").format("h:mm:ss A");

                const headerText = `WELCOME TO 🎭 𝗠𝗔🇱𝗘🇪𝗦𝗛𝗔 𝗖𝗜𝗡🇪 𝗛𝗨𝗕 🎭\n\n📅 Date : ${currentDate}\n⏰ Time : ${currentTime}\n🤖 Bot : 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀𝙈𝘼\n🟢 Status : Active 24/7\n\n`;

                switch (cleanBody) {
                    case '1': {
                        const subMenuText = `╭───〔 *🔍 SEARCH MENU* 〕───⊷\n│\n│ ${headerText}│ ▫️ *🍟.bs* - Baiscope Search\n│ ▫️ *🍟.cine* - CineSubz Search\n│ ▫️ *🍟.cineru* - Cineru.lk Search\n│ ▫️ *🍟.dm* - DinkaMovies Search\n│ ▫️ *🍟.sc* - Sinhala Cartoons Search\n│ ▫️ *🍟.shs* - Sinhala Hit Songs\n│ ▫️ *🍟.animeheaven* - Anime Search\n│ ▫️ *🍟.subcat* - Subtitle Search\n│ ▫️ *🍟.lksub* - LKSub Search\n│ ▫️ *🍟.thenkiri* - Thenkiri Search\n│ ▫️ *🍟.sinhalasub* - SinhalaSub Search\n│ ▫️ *🍟.cp* - Chithrapata.com Search\n│\n╰────────────────────────⊷\n\n> 👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽🍟`;
                        return await socket.sendMessage(from, { image: { url: MENU_IMAGE_URL }, caption: subMenuText }, { quoted: m });
                    }
                    case '2': {
                        const subMenuText = `╭───〔 *📥 DOWNLOAD MENU* 〕───⊷\n│\n│ ${headerText}│ ▫️ *✨.cine* - CineSubz Download\n│ ▫️ *✨.cineru* - Cineru.lk Download\n│ ▫️ *✨.dm* - DinkaMovies Download\n│ ▫️ *✨.sc* - Sinhala Cartoons Download\n│ ▫️ *✨.shs* - Sinhala Hit Songs Download\n│ ▫️ *✨.yt* / *.ytmp3* - YouTube Downloader\n│ ▫️ *✨.fb* - Facebook Downloader\n│ ▫️ *✨.tt* - TikTok Downloader\n│ ▫️ *✨.subdl* - Subtitle Download\n│ ▫️ *✨.an1* / *.a1* - MOD Games Download\n│ ▫️ *✨.dp* - WhatsApp DP Downloader\n│ ▫️ *✨.tk* - Thenkiri Download\n│ ▫️ *✨.ss* - SinhalaSub Download\n│ ▫️ *✨.cp* - Chithrapata Download\n│ ▫️ *✨.apk* - MOD Apps Download\n│\n╰────────────────────────⊷\n\n> 👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽 🍟`;
                        return await socket.sendMessage(from, { image: { url: MENU_IMAGE_URL }, caption: subMenuText }, { quoted: m });
                    }
                    case '3': {
                        const subMenuText = `╭───〔 *🎬 MOVIE & MUSIC MENU* 〕───⊷\n│\n│ ${headerText}│ ▫️ *🎬.cine* - CineSubz\n│ ▫️ *🎥.cineru* - Cineru.lk\n│ ▫️ *📽️.dm* - DinkaMovies\n│ ▫️ *🧩.sc* - Sinhala Cartoons\n│ ▫️ *🎧.shs* - Sinhala Hit Songs\n│ ▫️ *🌸.ah* - AnimeHeaven\n│ ▫️ *🦊.subcat* - Subtitles\n│ ▫️ *🍟.lksub* - LKSub\n│ ▫️ *⚡.thenkiri* - Thenkiri\n│ ▫️ *🇱🇰.sinhalasub* - SinhalaSub\n│ ▫️ *🍿.cp* - Chithrapata\n│\n╰────────────────────────⊷\n\n> 🤖 ᴄʀᴇᴀᴛᴇ ʙʏ ᴍᴀʟᴇᴇꜱʜᴀ 👻🍟`;
                        return await socket.sendMessage(from, { image: { url: MENU_IMAGE_URL }, caption: subMenuText }, { quoted: m });
                    }
                    case '4': {
                        const subMenuText = `╭───〔 *📤 SEND MENU* 〕───⊷\n│\n│ ${headerText}│ ▫️ *🎡.fwd* - Forward Message to Group\n│ ▫️ *🎡.jid* - Get Group JID\n│\n╰────────────────────────⊷\n\n> 👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽 🍟`;
                        return await socket.sendMessage(from, { image: { url: MENU_IMAGE_URL }, caption: subMenuText }, { quoted: m });
                    }
                    case '5': {
                        const subMenuText = `╭───〔 *👥 GROUP MENU* 〕───⊷\n│\n│ ${headerText}│ ▫️ *👑.jid* - Get Group JID\n│ ▫️ *👑.fwd* - Forward Message\n│\n╰────────────────────────⊷\n\n> 👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽 🍟`;
                        return await socket.sendMessage(from, { image: { url: MENU_IMAGE_URL }, caption: subMenuText }, { quoted: m });
                    }
                    case '6': {
                        return await socket.sendMessage(from, { text: `👋 MALIYA CINEMA BOT භාවිතා කළාට ස්තූතියි!` }, { quoted: m });
                    }
                }
            }
        }

        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        let args = body.trim().split(/ +/).slice(1);

        if (!command) return;

        try {
            switch (command) {
                case 'alive': {
                    try {
                        const date = moment().tz("Asia/Colombo").format("YYYY-MM-DD");
                        const time = moment().tz("Asia/Colombo").format("HH:mm:ss");
                        
                        await socket.sendMessage(from, { react: { text: '👋', key: m.key } });
                    
                        const ALIVE_MG = `
         HELLO ${botJid}
         
         User:- ${pushname}
         Date:- ${date}
         Time:- ${time}
         
         Get Bot Menu for type .menu
         `;
                         
                        await socket.sendMessage(from, {
                            text: ALIVE_MG,
                            contextInfo: {
                                mentionedJid: [botJid],
                                isForwarded: true,
                                forwardingScore: 999,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363412993089485@newsletter',
                                    newsletterName: '𝗠𝗔🇱𝗘🇪𝗦𝗛𝗔 𝗖𝗜𝗡🇪 𝗛𝗨𝗕🍟',
                                    serverMessageId: 999
                                },
                                externalAdReply: {
                                    containsAutoReply: true,
                                    title: '𝗠𝗔🇱𝗘🇪𝗦𝗛𝗔 𝗖𝗜𝗡🇪 𝗛𝗨𝗕 🍟',
                                    body: 'Power Full wa Bot',
                                    thumbnailUrl: 'https://cloud.laksidu.site/stream/96ceiC0G06/lakiya-1790694092748.jpg',
                                    sourceUrl: 'https://whatsapp.com/channel/0029Vb8x1Ww05MUln6ux1S3g',
                                    mediaType: 1,
                                    previewType: 0,
                                    renderLargerThumbnail: true
                                }
                            }
                        }, { quoted: supunmdq });
                    } catch (err) {
                        console.error('❌ Alive Error', err);
                        await socket.sendMessage(from, { text: '❌,Failed To Send Alive Command' });
                    }
                    break;
                }
               
                case 'menu': {
                    const currentDate = moment().tz("Asia/Colombo").format("YYYY/M/D");
                    const currentTime = moment().tz("Asia/Colombo").format("h:mm:ss A");

                    const mainMenuText = `⭐ _Hey , User |  ✨How are you._
🍟 *WELCOME TO MALIYA CINEMA*🦊
┌ *STATUS PANEL* ┐
│ 🌐 Good Day! 🌸
│ ⏰ Time : ${currentTime}
│ 📅 Date : ${currentDate}
│ 🎃 Bot Name: 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀𝙈𝘼
│ 🎡 Owner : MALEESHA
│ 🧩 Runtime: 24/7 Active
│ 💻 Platform: Linux
└───────────────┘

≡ 🔢 *REPLY WITH NUMBER* ≡

🔸 *1* ❯❯ *SEARCH MENU*
🔸 *2* ❯❯ *DOWNLOAD MENU*
🔸 *3* ❯❯ *MOVIE & MUSIC MENU*
🔸 *4* ❯❯ *SEND MENU*
🔸 *5* ❯❯ *GROUP MENU*
🔸 *6* ❯❯ *MAIN MENU*

📌 *මෙම පණිවිඩයට Reply කර අදාළ අංකය යවන්න (Ex: 1)*

| 🎭 𝗠𝗔🇱𝗘🇪𝗦𝗛𝗔 𝗖𝗜𝗡🇪 𝗛𝗨𝗕 🎭
| 🤖 ᴄʀᴇᴀᴛᴇ ʙʏ ᴍᴀʟᴇᴇꜱʜᴀ 👻`;

                    await socket.sendMessage(from, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: mainMenuText,
                        contextInfo: { mentionedJid: [m.sender] }
                    }, { quoted: m });
                    break;
                }     

                case 'pair': {
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                    const q = msg.message?.conversation ||
                              msg.message?.extendedTextMessage?.text ||
                              msg.message?.imageMessage?.caption ||
                              msg.message?.videoMessage?.caption || '';

                    const pairNumber = q.replace(/^[.\/!]pair\s*/i, '').trim();

                    if (!pairNumber) {
                        return await socket.sendMessage(from, { text: '*📌 Usage:* .pair +947XXXXXXX' }, { quoted: msg });
                    }

                    const cleanPairNum = pairNumber.replace(/[^0-9]/g, '');
                    if (!cleanPairNum) {
                        return await socket.sendMessage(from, { text: '❌ Invalid phone number format.' }, { quoted: msg });
                    }

                    try {
                        await socket.sendMessage(m.chat, { react: { text: '🔑', key: msg.key } });

                        const sessionPath = path.join(SESSION_BASE_PATH, `session_${cleanPairNum}`);
                        await fs.ensureDir(sessionPath);

                        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
                        const logger = pino({ level: 'fatal' });

                        const pairSocket = makeWASocket({
                            auth: {
                                creds: state.creds,
                                keys: makeCacheableSignalKeyStore(state.keys, logger)
                            },
                            logger,
                            browser: Browsers.ubuntu("Chrome"),
                            printQRInTerminal: false,
                            markOnlineOnConnect: false,
                            syncFullHistory: false
                        });

                        pairSocket.ev.on('creds.update', saveCreds);

                        let handedOver = false;
                        pairSocket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                            if (handedOver) return;
                            const code = lastDisconnect?.error?.output?.statusCode;
                            if (connection === 'open' || (connection === 'close' && code === 515)) {
                                handedOver = true;
                                if (connection === 'open') {
                                    try { pairSocket.end(undefined); } catch (e) {}
                                }
                                await delay(2000);
                                await EmpirePair(cleanPairNum, makeMockRes());
                            }
                        });
                        setTimeout(() => {
                            if (!handedOver) {
                                handedOver = true;
                                try { pairSocket.end(undefined); } catch (e) {}
                            }
                        }, 5 * 60 * 1000);

                        if (!state.creds.registered) {
                            await delay(4000);
                            const code = await pairSocket.requestPairingCode(cleanPairNum);
                            
                            await socket.sendMessage(from, {
                                text: `> *𝐏𝙰𝙸𝚁 𝐂𝙾𝙼𝙿𝙻𝙴𝑇𝐸Ɗ*✅\n\n*🔑 Your pairing code is:* ${code}\n\n📌Steps -\n On Your Phone:\n - Open WhatsApp\n - Tap 3 dots (⋮) or go to Settings\n - Tap Linked Devices\n - Link a Device\n - Link with Code\n - Enter the 8-digit code shown by the bot\n\n⚠ Important Instructions:\n1. ⏳ Pair this code within 1 minute.\n2. 🚫 Do not share this code with anyone.\n3. 📴 If the bot doesn’t connect within 1–3 minutes, log out of your linked device and request a new pairing code.\n\n> ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇳🇪𝙈𝘼 🍟`
                            }, { quoted: msg });

                            await sleep(2000);
                            await socket.sendMessage(from, { text: `${code}` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(from, { text: '❌ This number is already registered or connected.' }, { quoted: msg });
                        }
                    } catch (err) {
                        console.error("❌ Pair Command Error:", err);
                        await socket.sendMessage(from, { text: `❌ An error occurred while generating pairing code: ${err.message || err}` }, { quoted: msg });
                    }
                    break;
                }

                case 'jid': {
                    if (!isOwner) return reply('❌ Owner only');

                    const ctx = m.message.extendedTextMessage?.contextInfo;
                    const target = ctx?.participant || from;
                    await reply(`*Chat JID:* ${from}\n*User JID:* ${target}`);
                    break;
                }

                case 'forward':
                case 'fwd': {
                    if (!isOwner) return reply('❌ Owner only');

                    const ctx = m.message.extendedTextMessage?.contextInfo;
                    if (!ctx?.quotedMessage || !args[0]) {
                        return reply(
                            'Msg ekakata reply karala dapan:\n.forward <jid / number>\n\nEg: .forward 94771234567'
                        );
                    }

                    let target = args[0];
                    if (!target.includes('@')) target = target.replace(/\D/g, '') + '@s.whatsapp.net';

                    const quoted = {
                        key: {
                            remoteJid: from,
                            id: ctx.stanzaId,
                            participant: ctx.participant,
                            fromMe: false
                        },
                        message: ctx.quotedMessage
                    };

                    try {
                        await socket.sendMessage(target, { forward: quoted });
                    } catch (e) {
                        const qm = quoted.message;
                        const type = Object.keys(qm).find(
                            (k) => k.endsWith('Message') && k !== 'messageContextInfo'
                        );
                        const media = qm[type];
                        if (!['videoMessage', 'documentMessage', 'imageMessage', 'audioMessage'].includes(type)) {
                            throw e;
                        }

                        await reply('⏳ Direct forward fail una, re-upload karanawa...');

                        const stream = await downloadMediaMessage(
                            quoted,
                            'stream',
                            {},
                            { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage }
                        );

                        const caption = media.caption || '';
                        let content;
                        if (type === 'videoMessage') {
                            content = { video: { stream }, caption, mimetype: media.mimetype || 'video/mp4' };
                        } else if (type === 'documentMessage') {
                            content = {
                                document: { stream },
                                fileName: media.fileName || 'file',
                                mimetype: media.mimetype || 'application/octet-stream',
                                caption
                            };
                        } else if (type === 'imageMessage') {
                            content = { image: { stream }, caption };
                        } else {
                            content = { audio: { stream }, mimetype: media.mimetype || 'audio/mpeg' };
                        }

                        await socket.sendMessage(target, content);
                    }
                    await reply(`✅ Forwarded to ${target}`);
                    break;
                }

                case 'whatsapp_dp':
                case 'wadp':
                case 'dp': {
                    const DEFAULT_FOOTER = `\n\n> 👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽 🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🖼️ *Example:*\n• .wadp anime boy\n• .dp aesthetic girl\n• .dp sad boy\n\n📝 _Please provide a DP keyword!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const query = args.join(' ').trim();

                    await socket.sendMessage(from, { 
                        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching aesthetic WhatsApp DPs for:* _${query}_\n⚡ _Please wait..._`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/tools/whatsapp-dp', { q: query }, 30000);
                        const results = res.data.results || res.data.data || [];

                        if (!results.length) {
                            await socket.sendMessage(from, { text: `❌ *No DP pictures found for:* _${query}_${DEFAULT_FOOTER}` }, { quoted: m });
                            break;
                        }

                        for (const item of results.slice(0, 3)) {
                            const imgUrl = item.image_url || item.url || item.image;
                            if (imgUrl) {
                                await socket.sendMessage(from, {
                                    image: { url: imgUrl },
                                    caption: `*🖼️ 𝗪𝗛𝗔𝗧𝗦𝗔𝗣𝗣 𝗗𝗣: ${item.title || query.toUpperCase()}*${DEFAULT_FOOTER}`
                                }, { quoted: m });
                            }
                        }
                    } catch (err) {
                        console.error("DP Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *WhatsApp DP Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'a1':
                case 'an1': {
                    const DEFAULT_FOOTER = `\n\n> ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎮 *Example:*\n• .an1 shadow fight 2\n• .a1 subway surfers\n\n📝 _Please provide the Game or App name!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const query = args.join(' ').trim();
                    const DEFAULT_IMAGE = "https://api.chamindu.site/logo.png";

                    await socket.sendMessage(from, { 
                        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching AN1 for MOD games:* _${query}_\n⚡ _Please wait a moment..._`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/games/an1/search', { q: query }, 30000);
                        const results = res.data.data || res.data.results || [];

                        if (!results.length) {
                            await socket.sendMessage(from, {
                                text: `*❪ NO RESULTS ❫*\n\n😞 *No MOD Games Found for:* _${query}_${DEFAULT_FOOTER}`
                            }, { quoted: m });
                            break;
                        }

                        let listText = `*❪ AN1 MOD GAMES SEARCH ❫*\n\n🎯 *Query:* _${query}_\n📊 *Total:* _${results.length} Games_\n\n*👇 SELECT A NUMBER 👇*\n\n`;
                        results.slice(0, 15).forEach((item, index) => {
                            const num = (index + 1) < 10 ? `0${index + 1}` : `${index + 1}`;
                            listText += `*${num}* ➜ 🎮 _${(item.title || 'Game').substring(0, 32)}_\n`;
                        });
                        listText += `\n📌 _Reply with the number to get MOD download link!_${DEFAULT_FOOTER}`;

                        const sentMsg = await socket.sendMessage(from, { text: listText }, { quoted: m });
                        const messageID = sentMsg.key.id;

                        const handleSelection = async ({ messages: replyMessages }) => {
                            const replyMek = replyMessages[0];
                            if (!replyMek?.message) return;

                            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
                            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;

                            if (isReplyToSentMsg && from === replyMek.key.remoteJid) {
                                const choice = parseInt(messageType) - 1;
                                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                                    await socket.sendMessage(from, { text: `⚠️ *Invalid choice! Range: 01 - ${results.length}*` }, { quoted: replyMek });
                                    return;
                                }

                                const selectedGame = results[choice];
                                await socket.sendMessage(from, { 
                                    text: `*❪ FETCHING ❫*\n\n🎮 *Fetching AN1 MOD download link...*\n⚡ _Please wait..._`
                                }, { quoted: replyMek });

                                try {
                                    const infoRes = await fetchChaminduApi('/api/v1/games/an1/info', { url: selectedGame.link || selectedGame.url }, 30000);
                                    const gameData = infoRes.data.data || infoRes.data || {};
                                    const dlLink = gameData.download_link || gameData.link || selectedGame.link || selectedGame.url;

                                    let an1Text = `*❪ AN1 MOD GAME DETAILS ❫*\n\n🎮 *Game:* ${gameData.title || selectedGame.title}\n⚡ *Status:* MOD Unlocked (Unlimited Money)\n\n📥 *DOWNLOAD LINK:*\n🔗 ${dlLink}${DEFAULT_FOOTER}`;

                                    await socket.sendMessage(from, {
                                        image: { url: gameData.image || selectedGame.image || DEFAULT_IMAGE },
                                        caption: an1Text
                                    }, { quoted: replyMek });

                                } catch (infoErr) {
                                    console.error("AN1 Info Error:", infoErr.response?.data || infoErr.message);
                                    await socket.sendMessage(from, { text: `❌ *AN1 Info Error:* ${infoErr.message}${DEFAULT_FOOTER}` }, { quoted: replyMek });
                                }
                                socket.ev.off('messages.upsert', handleSelection);
                            }
                        };
                        socket.ev.on('messages.upsert', handleSelection);
                        setTimeout(() => socket.ev.off('messages.upsert', handleSelection), 10 * 60 * 1000);
                    } catch (err) {
                        console.error("AN1 Search Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *AN1 Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'gemini': {
                    try {
                        const query = args.join(" ") || 
                            msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            msg.message?.imageMessage?.caption || 
                            msg.message?.videoMessage?.caption || 
                            "";
                        
                        if (!query.trim()) {
                            await socket.sendMessage(from, { text: '❌ Please provide a prompt for Gemini AI.' }, { quoted: msg });
                            break;
                        }

                        const response = await fetchJson(`https://supunofc.site/api/ai/chatday/chat?prompt=${encodeURIComponent(query)}&model=google%2Fgemini-3.1-flash-lite&apikey=${config.SUPUN_API_KEY}`);
                        const resultText = response?.result?.result || response?.result || response?.data || '❌ No response received from Gemini AI.';

                        await socket.sendMessage(from, { text: String(resultText) }, { quoted: msg });
                    } catch (err) {
                        console.error("Error Gemini Ai:", err);
                        await socket.sendMessage(from, { text: '*❌ Internal AI Error. Please try again later.*' }, { quoted: msg });
                    }
                    break;
                }

                case 'deepsheek-ai': {
                    try {
                        const query = args.join(" ") ||
                            msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption ||
                            '';

                        if (!query.trim()) {
                            await socket.sendMessage(from, { text: '❌ Please provide a question for DeepSeek AI.' }, { quoted: msg });
                            break;
                        }

                        const aiResponse = await askDeepSeek(query);
                        const deepSeekText = aiResponse?.results || aiResponse?.result || aiResponse?.response || '❌ No response received from DeepSeek AI.';

                        await socket.sendMessage(from, { text: String(deepSeekText) }, { quoted: msg });
                    } catch (err) {
                        console.error('DeepSeek AI Error:', err);
                        await socket.sendMessage(from, { text: `❌ Error fetching DeepSeek AI data: ${err.message}` }, { quoted: msg });
                    }
                    break;
                }

                case 'sinhalahitsongs':
                case 'shs': {
                    const DEFAULT_FOOTER = `\n\n> 👑 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀 𝙃𝙐𝘽 🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎵 *Example:*\n• .sinhalahitsongs ruwan tharuka\n• .shs obata man adare bawanawak\n\n📝 _Please provide the Sinhala song title!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const query = args.join(' ').trim();

                    await socket.sendMessage(from, { 
                        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching Sinhala Hit Songs for:* _${query}_\n⚡ _Please wait a moment..._`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/music/sinhalahitsongs/search', { q: query }, 30000);
                        const results = res.data.data || res.data.results || [];

                        if (!results.length) {
                            await socket.sendMessage(from, {
                                text: `*❪ NO RESULTS ❫*\n\n😞 *No Sinhala Songs Found for:* _${query}_${DEFAULT_FOOTER}`
                            }, { quoted: m });
                            break;
                        }

                        let listText = `*❪ SINHALA HIT SONGS ❫*\n\n🎯 *Query:* _${query}_\n📊 *Total:* _${results.length} Songs_\n\n*👇 SELECT A NUMBER 👇*\n\n`;
                        results.slice(0, 15).forEach((item, index) => {
                            const num = (index + 1) < 10 ? `0${index + 1}` : `${index + 1}`;
                            listText += `*${num}* ➜ 🎵 _${(item.title || 'Song').substring(0, 32)}_\n`;
                        });
                        listText += `\n📌 _Reply with the number to download MP3!_${DEFAULT_FOOTER}`;

                        const sentMsg = await socket.sendMessage(from, { text: listText }, { quoted: m });
                        const messageID = sentMsg.key.id;

                        const handleSelection = async ({ messages: replyMessages }) => {
                            const replyMek = replyMessages[0];
                            if (!replyMek?.message) return;

                            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
                            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;

                            if (isReplyToSentMsg && from === replyMek.key.remoteJid) {
                                const choice = parseInt(messageType) - 1;
                                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                                    await socket.sendMessage(from, { text: `⚠️ *Invalid choice! Range: 01 - ${results.length}*` }, { quoted: replyMek });
                                    return;
                                }

                                const selectedSong = results[choice];
                                await socket.sendMessage(from, { 
                                    text: `*❪ DOWNLOADING ❫*\n\n🎵 *Downloading:* _${selectedSong.title}_\n⚡ _Sending MP3 file..._`
                                }, { quoted: replyMek });

                                try {
                                    const dlRes = await fetchChaminduApi('/api/v1/music/sinhalahitsongs/download', { url: selectedSong.link || selectedSong.url }, 60000);
                                    const mp3Url = dlRes.data.download_link || dlRes.data.data?.download_link || dlRes.data.url;

                                    if (mp3Url) {
                                        await socket.sendMessage(from, {
                                            audio: { url: mp3Url },
                                            mimetype: 'audio/mpeg',
                                            fileName: `${selectedSong.title}.mp3`,
                                            ptt: false
                                        }, { quoted: replyMek });
                                    } else {
                                        await socket.sendMessage(from, { text: `❌ *MP3 download link unavailable.*${DEFAULT_FOOTER}` }, { quoted: replyMek });
                                    }
                                } catch (dlErr) {
                                    console.error("Sinhala Songs DL Error:", dlErr.response?.data || dlErr.message);
                                    await socket.sendMessage(from, { text: `❌ *Download Error:* ${dlErr.message}${DEFAULT_FOOTER}` }, { quoted: replyMek });
                                }
                                socket.ev.off('messages.upsert', handleSelection);
                            }
                        };
                        socket.ev.on('messages.upsert', handleSelection);
                        setTimeout(() => socket.ev.off('messages.upsert', handleSelection), 10 * 60 * 1000);
                    } catch (err) {
                        console.error("Sinhala Songs Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *Sinhala Hit Songs Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'youtube':
                case 'yt':
                case 'ytmp3': {
                    const DEFAULT_FOOTER = `\n\n> 𝗠𝗔🇱𝗘🇪𝗦𝗛𝗔 𝗖𝗜𝗡🇪 𝗛𝗨𝗕🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• .youtube https://youtu.be/xxxx\n• .ytmp3 https://youtu.be/xxxx\n\n📝 _Please provide a YouTube video URL!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const commandUsed = args[0].startsWith('http') ? (body || '').split(' ')[0].toLowerCase().replace('.', '') : 'youtube';
                    const isAudio = commandUsed === 'ytmp3' || args.includes('mp3') || args.includes('audio');
                    const dlType = isAudio ? 'mp3' : 'video';
                    const url = args.find(a => a.startsWith('http')) || args[0];

                    await socket.sendMessage(from, { 
                        text: `*❪ CONVERTING ❫*\n\n⚡ *Fetching YouTube ${dlType.toUpperCase()} (320kbps/HD)...*\n⏳ _Please wait a moment..._`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/download/youtube', { url: url, type: dlType }, 60000);
                        const ytData = res.data.data || res.data;

                        const downloadUrl = ytData.download_url || ytData.url || ytData.dl_link;

                        if (!ytData || !downloadUrl) {
                            await socket.sendMessage(from, { text: `❌ *Failed to extract YouTube ${dlType.toUpperCase()}!*${DEFAULT_FOOTER}` }, { quoted: m });
                            break;
                        }

                        const title = ytData.title || 'YouTube_Download';

                        if (isAudio) {
                            await socket.sendMessage(from, {
                                audio: { url: downloadUrl },
                                mimetype: 'audio/mpeg',
                                fileName: `${title}.mp3`,
                                ptt: false
                            }, { quoted: m });
                        } else {
                            await socket.sendMessage(from, {
                                video: { url: downloadUrl },
                                caption: `*🎬 𝗬O𝗨𝗧𝗨E 𝙈𝘼𝙇𝙄𝙔𝘼 𝘾𝙄𝙉𝙀𝙈𝘼 🎬*\n\n📌 *Title:* ${title}\n⏳ *Duration:* ${ytData.duration || 'N/A'}${DEFAULT_FOOTER}`
                            }, { quoted: m });
                        }
                    } catch (err) {
                        console.error("YouTube DL Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *YouTube Download Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'tiktok':
                case 'tt': {
                    const DEFAULT_FOOTER = `\n\n> ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n📥 *Example:*\n• .tiktok https://vm.tiktok.com/xxxx/\n• .tt https://vt.tiktok.com/xxxx/\n\n📝 _Please provide a TikTok video URL!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const url = args[0].trim();

                    await socket.sendMessage(from, { 
                        text: `*❪ DOWNLOADING ❫*\n\n⚡ *Fetching TikTok HD Video without watermark...*`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/download/tiktok', { url: url }, 30000);
                        const data = res.data.data || res.data;

                        const videoUrl = data.downloads?.no_watermark_hd || data.downloads?.no_watermark || data.nowm || data.url;
                        const caption = `*🎵 𝗧I🇰𝗧O🇰 𝗛🇩 𝗗O🇼𝗡🇱O𝗔🇩 🎵*\n\n📝 *Title:* ${data.title || 'TikTok Video'}\n👤 *Author:* ${data.author || 'Creator'}${DEFAULT_FOOTER}`;

                        if (videoUrl) {
                            await socket.sendMessage(from, {
                                video: { url: videoUrl },
                                caption: caption
                            }, { quoted: m });
                        } else {
                            await socket.sendMessage(from, { text: `⚠️ *No watermark-free link available!*${DEFAULT_FOOTER}` }, { quoted: m });
                        }
                    } catch (err) {
                        console.error("TikTok DL Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *TikTok Download Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'facebook':
                case 'fb': {
                    const DEFAULT_FOOTER = `\n\n> ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n📘 *Example:*\n• .facebook https://www.facebook.com/watch?v=xxxx\n• .fb https://fb.watch/xxxx/\n\n📝 _Please provide Facebook video link!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const url = args[0].trim();

                    await socket.sendMessage(from, { 
                        text: `*❪ DOWNLOADING ❫*\n\n⚡ *Fetching Facebook Video in HD quality...*`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/download/facebook', { url: url }, 30000);
                        const data = res.data.data || res.data;

                        if (!data || (!data.hd && !data.sd && !data.url)) {
                            await socket.sendMessage(from, { text: `❌ *Could not extract Facebook video. Make sure the video is public!*${DEFAULT_FOOTER}` }, { quoted: m });
                            break;
                        }

                        const videoUrl = data.hd || data.sd || data.url;
                        const qualityTag = data.hd ? "HD" : "SD";

                        await socket.sendMessage(from, {
                            video: { url: videoUrl },
                            caption: `*📘 𝗙𝗔𝗖🇪🇧OO🇰 𝗩I🇩🇪O 𝗗O🇼𝗡🇱O𝗔🇩 📘*\n\n📌 *Title:* ${data.title || 'Facebook Video'}\n📊 *Quality:* ${qualityTag}${DEFAULT_FOOTER}`
                        }, { quoted: m });
                    } catch (err) {
                        console.error("FB DL Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *Facebook Download Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'liteapks':
                case 'apk': {
                    const DEFAULT_FOOTER = `\n\n> ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟`;

                    if (!args.length) {
                        await socket.sendMessage(from, {
                            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n📱 *Example:*\n• .liteapks spotify\n• .apk capcut\n\n📝 _Please provide the App or Game name!_${DEFAULT_FOOTER}`
                        }, { quoted: m });
                        break;
                    }

                    const query = args.join(' ').trim();
                    const DEFAULT_IMAGE = "https://api.chamindu.site/logo.png";

                    await socket.sendMessage(from, { 
                        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching LiteAPKs for:* _${query}_\n⚡ _Please wait a moment..._`
                    }, { quoted: m });

                    try {
                        const res = await fetchChaminduApi('/api/v1/apps/liteapks/search', { q: query }, 30000);
                        const results = res.data.data || res.data.results || [];

                        if (!results.length) {
                            await socket.sendMessage(from, {
                                text: `*❪ NO RESULTS ❫*\n\n😞 *No MOD APKs Found for:* _${query}_${DEFAULT_FOOTER}`
                            }, { quoted: m });
                            break;
                        }

                        let listText = `*❪ LITEAPKS MOD SEARCH ❫*\n\n🎯 *Query:* _${query}_\n📊 *Total:* _${results.length} Apps_\n\n*👇 SELECT A NUMBER 👇*\n\n`;
                        results.slice(0, 15).forEach((item, index) => {
                            const num = (index + 1) < 10 ? `0${index + 1}` : `${index + 1}`;
                            listText += `*${num}* ➜ 📱 _${(item.title || 'App').substring(0, 32)}_ (${item.version || 'Latest'})\n`;
                        });
                        listText += `\n📌 _Reply with the number to get APK links!_${DEFAULT_FOOTER}`;

                        const sentMsg = await socket.sendMessage(from, { text: listText }, { quoted: m });
                        const messageID = sentMsg.key.id;

                        const handleSelection = async ({ messages: replyMessages }) => {
                            const replyMek = replyMessages[0];
                            if (!replyMek?.message) return;

                            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
                            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;

                            if (isReplyToSentMsg && from === replyMek.key.remoteJid) {
                                const choice = parseInt(messageType) - 1;
                                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                                    await socket.sendMessage(from, { text: `⚠️ *Invalid choice! Range: 01 - ${results.length}*` }, { quoted: replyMek });
                                    return;
                                }

                                const selectedApp = results[choice];
                                await socket.sendMessage(from, { 
                                    text: `*❪ FETCHING ❫*\n\n📱 *Fetching APK download links...*\n⚡ _Please wait..._`
                                }, { quoted: replyMek });

                                try {
                                    const infoRes = await fetchChaminduApi('/api/v1/apps/liteapks/info', { url: selectedApp.link || selectedApp.url }, 30000);
                                    const appData = infoRes.data.data || infoRes.data || {};
                                    const downloads = appData.downloads || appData.download_links || [];

                                    let appText = `*❪ LITEAPKS MOD DETAILS ❫*\n\n📱 *App:* ${appData.title || selectedApp.title}\n🔖 *Version:* ${appData.version || 'Latest'}\n\n*📥 DOWNLOAD LINKS:*\n`;

                                    if (downloads.length > 0) {
                                        downloads.slice(0, 5).forEach((dl, idx) => {
                                            appText += `\n*${idx + 1}. ${dl.name || 'MOD APK'}:*\n🔗 ${dl.url || dl.link}\n`;
                                        });
                                    } else {
                                        appText += `\n⚠️ *Download page:* ${selectedApp.link || selectedApp.url}\n`;
                                    }

                                    appText += DEFAULT_FOOTER;

                                    await socket.sendMessage(from, {
                                        image: { url: appData.image || selectedApp.image || DEFAULT_IMAGE },
                                        caption: appText
                                    }, { quoted: replyMek });

                                } catch (infoErr) {
                                    console.error("LiteAPKs Info Error:", infoErr.response?.data || infoErr.message);
                                    await socket.sendMessage(from, { text: `❌ *LiteAPKs Info Error:* ${infoErr.message}${DEFAULT_FOOTER}` }, { quoted: replyMek });
                                }
                                socket.ev.off('messages.upsert', handleSelection);
                            }
                        };
                        socket.ev.on('messages.upsert', handleSelection);
                        setTimeout(() => socket.ev.off('messages.upsert', handleSelection), 10 * 60 * 1000);
                    } catch (err) {
                        console.error("LiteAPKs Error:", err.response?.data || err.message);
                        await socket.sendMessage(from, { text: `❌ *LiteAPKs Error:* ${err.message}${DEFAULT_FOOTER}` }, { quoted: m });
                    }
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    try {
                        const loading = await socket.sendMessage(from, { text: '*𝗧🇪🇸𝗧I🇳🇬 𝗧𝗛🇪 𝗕O𝗧*' }, { quoted: msg });
                        const stages = ['○○○○○', '●○○○○', '●●○○○', '●●●○○', '●●●●○', '●●●●●'];

                        for (const stage of stages) {
                            await socket.sendMessage(from, { text: `*${stage}*`, edit: loading.key });
                            await new Promise(resolve => setTimeout(resolve, 250));
                        }

                        const ping = Date.now() - start;
                        await socket.sendMessage(from, {
                            text: `╭───〔 *🏓 PING STATUS* 〕───⊷\n│\n│ ⚡ *Response:* ${ping} ms\n│ 🤖 *Bot:* ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇳🇪𝙈𝘼 🍟\n│ 🟢 *Status:* 24/7 Online\n│\n╰────────────────────────⊷`,
                            edit: loading.key
                        });
                    } catch (err) {
                        console.error('Ping Command Error:', err);
                    }
                    break;
                }

                case 'deleteme': {
                    await fullDeleteSession(number);
                    await socket.sendMessage(from, { text: '✅ Your session has been deleted.' });
                    break;
                }

                case 'owner': {
                    await socket.sendMessage(from, { react: { text: '👦💻', key: m.key } });
                    const ownerContact = {
                        contacts: {
                            displayName: '✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟',
                            contacts: [{ vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Maleesha\nTEL;TYPE=CELL:0761602392\nEND:VCARD' }]
                        }
                    };
                    await socket.sendMessage(from, ownerContact);
                    break;
                }

                default:
                    if (isCmd && !MOVIE_CMDS.includes(command)) {
                        await socket.sendMessage(from, { text: '❌ Invalid command. Type .menu for available commands.' }, { quoted: msg });
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling command:', error);
            await socket.sendMessage(from, { text: '❌ An error occurred while processing your command.' }, { quoted: msg });
        }
    } catch (outerErr) {
        console.error('messages.upsert handler error:', outerErr && outerErr.message ? outerErr.message : outerErr);
    } });
}

async function EmpirePair(number, res) {
    if (!number) {
        if (res && !res.headersSent) {
            return res.status(400).send({ error: 'Phone number is required.' });
        }
        return;
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    if (activeSockets.has(sanitizedNumber)) {
        const existingSocket = activeSockets.get(sanitizedNumber);
        if (existingSocket && existingSocket.ws && existingSocket.ws.isOpen) {
            if (res && !res.headersSent) {
                res.send({ status: 'already_connected', message: 'Socket is already active.' });
            }
            return;
        } else if (Date.now() - (socketCreationTime.get(sanitizedNumber) || 0) < 45000) {
            if (res && !res.headersSent) {
                res.send({ status: 'connecting', message: 'Socket is connecting.' });
            }
            return;
        } else {
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            try { existingSocket.end(undefined); } catch (e) {}
        }
    }

    if (initializingNumbers.has(sanitizedNumber)) {
        if (res && !res.headersSent) {
            res.send({ status: 'connecting', message: 'Socket is initializing.' });
        }
        return;
    }
    initializingNumbers.add(sanitizedNumber);

    try {
        fs.ensureDirSync(sessionPath);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const logger = pino({ level: 'fatal' });

        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 15000,
            connectTimeoutMs: 60000
        });

        activeSockets.set(sanitizedNumber, socket);
        socketCreationTime.set(sanitizedNumber, Date.now());
        initializingNumbers.delete(sanitizedNumber);

        setupAutoRestart(socket, sanitizedNumber);
        setupCommandHandlers(socket, sanitizedNumber);

        registerMovieCommands(socket, config);

        socket.ev.on('creds.update', saveCreds);

        if (!socket.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const pairingCode = await socket.requestPairingCode(sanitizedNumber);
                    if (res && !res.headersSent) {
                        res.send({ code: pairingCode });
                    }
                } catch (error) {
                    console.error('Failed to request pairing code:', error);
                    if (res && !res.headersSent) {
                        res.status(500).send({ error: 'Failed to request pairing code.' });
                    }
                }
            }, 3000);
        } else {
            if (res && !res.headersSent) {
                res.send({ status: 'already_registered', message: 'User is already registered.' });
            }
        }
    } catch (error) {
        console.error('Error in EmpirePair:', error);
        initializingNumbers.delete(sanitizedNumber);
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            res.status(500).send({ error: 'Failed to initialize pairing.' });
        }
    }
}

function getSavedNumbers() {
    try {
        return fs.readdirSync(SESSION_BASE_PATH)
            .map(d => (d.match(/^session_(\d+)$/) || [])[1])
            .filter(Boolean)
            .filter(n => {
                try {
                    const creds = fs.readJsonSync(path.join(SESSION_BASE_PATH, `session_${n}`, 'creds.json'));
                    return !!creds.registered;
                } catch (e) {
                    return false;
                }
            });
    } catch (e) {
        return [];
    }
}

async function restartSocket(number) {
    const clean = number.replace(/[^0-9]/g, '');
    restartingNumbers.add(clean);
    try {
        if (pendingAutoReconnect.has(clean)) {
            clearTimeout(pendingAutoReconnect.get(clean));
            pendingAutoReconnect.delete(clean);
        }
        const old = activeSockets.get(clean);
        if (old) {
            activeSockets.delete(clean);
            socketCreationTime.delete(clean);
            try { old.end(undefined); } catch (e) { try { old.ws.close(); } catch (e2) {} }
        }
        await delay(2000);
    } finally {
        restartingNumbers.delete(clean);
    }
    await EmpirePair(clean, makeMockRes());
}

let refreshRunning = false;
async function refreshAllSockets() {
    if (refreshRunning) return;
    refreshRunning = true;
    try {
        const numbers = new Set([...activeSockets.keys(), ...getSavedNumbers()]);
        console.log(`🔄 [4h refresh] bots ${numbers.size} restart karanawa...`);
        for (const n of numbers) {
            try {
                await restartSocket(n);
                console.log(`✅ [4h refresh] ${n} reactive una`);
            } catch (e) {
                console.error(`❌ [4h refresh] ${n} fail:`, e.message || e);
            }
            await delay(5000);
        }
    } finally {
        refreshRunning = false;
    }
}
setInterval(refreshAllSockets, REFRESH_INTERVAL_MS);

async function watchdog() {
    try {
        for (const [n, sock] of Array.from(activeSockets.entries())) {
            const open = !!(sock && sock.ws && sock.ws.isOpen);
            if (open) { staleStrikes.delete(n); continue; }
            const age = Date.now() - (socketCreationTime.get(n) || 0);
            if (age < 60000 || restartingNumbers.has(n)) continue;
            const strikes = (staleStrikes.get(n) || 0) + 1;
            staleStrikes.set(n, strikes);
            if (strikes >= 2) {
                staleStrikes.delete(n);
                console.log(`🐶 [watchdog] ${n} socket eka dead. Restart karanawa...`);
                await restartSocket(n);
            }
        }

        for (const n of getSavedNumbers()) {
            if (activeSockets.has(n) || pendingAutoReconnect.has(n) || restartingNumbers.has(n) || initializingNumbers.has(n)) continue;
            console.log(`🐶 [watchdog] ${n} inactive. Start karanawa...`);
            await EmpirePair(n, makeMockRes());
            await delay(3000);
        }
    } catch (e) {
        console.error('[watchdog] error:', e && e.message ? e.message : e);
    }
}
setInterval(watchdog, 30 * 1000);
setTimeout(watchdog, 5 * 1000);

router.get('/ping', (req, res) => {
    return res.status(200).send({ status: 'online', uptime: process.uptime(), active_bots: activeSockets.size });
});

router.get('/', (req, res) => {
    const number = req.query.number;
    if (!number) {
        return res.status(400).send({ error: 'Phone number is required.' });
    }
    EmpirePair(number, res);
});

module.exports = router;
