const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { getContentType } = require('@whiskeysockets/baileys');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function openStream(url) {
    return await axios.get(url, {
        responseType: 'stream',
        maxRedirects: 10,
        timeout: 60000,
        headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/' },
        validateStatus: s => s < 400
    });
}

// Real video nam download karala tmp file path eka denawa, nathnam null (HTML / json / podi file)
async function downloadVideo(url) {
    const res = await openStream(url);
    const type = (res.headers['content-type'] || '').toLowerCase();
    const size = parseInt(res.headers['content-length'] || '0');

    if (type.includes('text/html') || type.includes('json') || (size && size < 1024 * 1024)) {
        res.data.destroy();
        return null;
    }

    const tmp = path.join(os.tmpdir(), `mv_${Date.now()}.mp4`);
    await pipeline(res.data, fs.createWriteStream(tmp));

    // download una file eka podi nam (HTML page ekak wage), reject karanna
    if (fs.statSync(tmp).size < 1024 * 1024) {
        fs.unlink(tmp, () => {});
        return null;
    }
    return tmp;
}

// .m3u8 (HLS) stream ekak mp4 ekata convert karanawa (ffmpeg install wela thiyenna one)
function runFfmpeg(url, out) {
    return new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-headers', `User-Agent: ${UA}\r\n`,
            '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out
        ]);
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve(out) : reject(new Error('ffmpeg exit ' + code)));
    });
}

// HTML page ekak athule thiyena .mp4 / .m3u8 link eka hoyanawa (AnimeHeaven wage sites walata)
async function scrapeVideoUrl(pageUrl) {
    const res = await axios.get(pageUrl, {
        headers: { 'User-Agent': UA, Referer: new URL(pageUrl).origin + '/' },
        timeout: 30000,
        maxRedirects: 10
    });
    const html = (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).replace(/\\\//g, '/');
    const m = html.match(/https?:\/\/[^"'\s<>\\]+?\.(?:mp4|m3u8)[^"'\s<>\\]*/i);
    return m ? m[0] : null;
}

// Link eka direct mp4 nam download, page ekak nam athule video link eka hoya gannawa, m3u8 nam convert
async function fetchToTmp(url) {
    let target = url;
    for (let i = 0; i < 2; i++) {
        if (/\.m3u8(\?|$)/i.test(target)) {
            const out = path.join(os.tmpdir(), `mv_${Date.now()}.mp4`);
            await runFfmpeg(target, out);
            return out;
        }
        const file = await downloadVideo(target);
        if (file) return file;
        const found = await scrapeVideoUrl(target).catch(() => null);
        if (!found || found === target) return null;
        target = found;
    }
    return null;
}

// File eka WhatsApp ekata upload karanawa. 'ok' | 'notdirect' | 'toolarge' return karanawa
async function sendVideoFile(socket, from, fileUrl, fileName, caption, quoted) {
    let tmpFile = null;
    try {
        tmpFile = await fetchToTmp(fileUrl);
        if (!tmpFile) return 'notdirect';
        const sizeMB = fs.statSync(tmpFile).size / 1024 / 1024;
        if (sizeMB > 1900) return 'toolarge';

        const content = { document: { url: tmpFile }, mimetype: 'video/mp4', fileName, caption };
        try {
            await socket.sendMessage(from, content, quoted ? { quoted } : {});
        } catch (e) {
            console.error('Quoted send failed, retrying without quote:', e.message);
            await socket.sendMessage(from, content);
        }
        return 'ok';
    } finally {
        if (tmpFile && fs.existsSync(tmpFile)) fs.unlink(tmpFile, () => {});
    }
}

const getLink = dl => dl.direct_link || dl.download_link || dl.link || dl.url || dl.href;
const getLabel = (dl, i) => dl.quality || dl.title || dl.episode || dl.name || `Part ${i + 1}`;

// Downloads array eka wena API walin wena key walin enna puluwan, eka nisa hoyaganna
const pickDownloads = info => {
    if (!info || typeof info !== 'object') return [];
    const keys = ['downloads', 'links', 'download_links', 'downloadLinks', 'dl_links', 'download', 'episodes'];
    for (const k of keys) {
        if (Array.isArray(info[k]) && info[k].length) return info[k];
    }
    for (const v of Object.values(info)) {
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && getLink(v[0])) return v;
    }
    return [];
};

// year nathnam title eke (2026) wage eka ganna
const getYear = item => item.year || ((item.title || '').match(/\((\d{4})\)/) || [])[1] || 'N/A';

// Error ekak short text ekak widiyata (user ta pennanna)
const errTag = err => {
    const detail = err?.apiDetail || err?.response?.data?.detail || err?.response?.data?.message;
    const code = err?.response?.status || err?.code || err?.message || 'error';
    return detail ? `${code}: ${String(detail).slice(0, 80)}` : code;
};

function registerMovieCommands(socket, config) {
    const DEFAULT_FOOTER = `\n\n> ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟`;
    const API_BASE = "https://api.chamindu.site";
    // API key eka config ekata (CHAMINDU_API_KEY) nathnam .env ekata danna. Code ekata hardcode karanna epa.
    const API_KEY = config.CHAMINDU_API_KEY || process.env.CHAMINDU_API_KEY || "chama_api_3c15ae06aa01956a74e89c68a5d59a91";
    const DEFAULT_IMAGE = "https://api.chamindu.site/logo.png";

    // Fallback provider (Chamindu quota iwara unama / key invalid unama me eka use wenawa)
    const SUPUN_BASE = "https://supunofc.site";
    const SUPUN_KEY = config.SUPUN_API_KEY || process.env.SUPUN_API_KEY || "supun-4apwzn10apu3tf0uk41bimnq";

    // Chamindu quota iwara / key invalid unama, tikak welawakata eka skip karala direct Supun ekata yanawa
    let chaminduSkipUntil = 0;
    const supunDetailPath = new Map(); // wada karana Supun details endpoint eka cache karanawa

    if (!API_KEY) console.warn('[movie] CHAMINDU_API_KEY set karala nathi! API calls fail wenawa.');

    // API call eka. api_key / apikey / x-api-key kramaya 3ma try karanawa, log ekath thiyenawa
    async function apiGet(apiPath, q, timeout = 60000) {
        const attempts = [
            { params: { q, api_key: API_KEY } },
            { params: { q, apikey: API_KEY } },
            { params: { q }, headers: { 'x-api-key': API_KEY } }
        ];
        let lastErr;
        for (const a of attempts) {
            if (Date.now() < chaminduSkipUntil) break;
            try {
                const res = await axios.get(`${API_BASE}${apiPath}`, {
                    timeout,
                    headers: { 'User-Agent': UA, ...(a.headers || {}) },
                    params: a.params
                });
                // API eka 200 danawa success:false ekka nam eka fail ekak widiyata ganna
                if (res.data && (res.data.success === false || res.data.status === false)) {
                    const e = new Error(res.data.detail || res.data.message || 'API returned status=false');
                    e.apiDetail = res.data.detail || res.data.message;
                    throw e;
                }
                return res;
            } catch (e) {
                lastErr = e;
                console.error(
                    `[movie] API fail ${apiPath} ->`,
                    e.response?.status || e.code || '',
                    JSON.stringify(e.response?.data || e.message).slice(0, 300)
                );
                // 404 / 5xx welawata auth variant wenas karala wada na, eka nisa nawaththanna
                if (/quota|exhaust|invalid api key|api key is missing/i.test(e.apiDetail || '')) {
                    chaminduSkipUntil = Date.now() + 30 * 60 * 1000; // minutes 30k skip
                    console.warn('[movie] Chamindu API skip karanawa minutes 30k (quota/key awul)');
                }
                if (e.apiDetail) break; // API eken direct reason ekak awa (quota / invalid key), retry karanna epa
                const st = e.response?.status;
                if (st && st !== 401 && st !== 403 && st !== 400) break;
            }
        }
        // Chamindu fail unoth (quota / invalid key / down), Supun API eken try karanawa
        if (SUPUN_KEY) {
            const base = apiPath.replace('/api/v1/', '/api/');
            let candidates = [base];
            let root = null;

            // Details endpoint eke nama Supun eke wenas wenna puluwan, eka nisa pahala ewa try karanawa
            if (/\/infodl$/.test(base)) {
                root = base.replace(/\/infodl$/, '');
                candidates = [...new Set([
                    supunDetailPath.get(root),
                    `${root}/infodl`, `${root}/info`, `${root}/download`, `${root}/dl`,
                    `${root}/details`, `${root}/detail`, `${root}/movie`, `${root}/get`
                ].filter(Boolean))];
            }

            for (const sPath of candidates) {
                try {
                    const res = await axios.get(`${SUPUN_BASE}${sPath}`, {
                        timeout,
                        headers: { 'User-Agent': UA },
                        params: { q, url: q, apikey: SUPUN_KEY }
                    });
                    if (res.data && (res.data.success === false || res.data.status === false)) {
                        throw new Error(res.data.detail || res.data.message || res.data.error || 'Supun API returned failure');
                    }
                    if (root) supunDetailPath.set(root, sPath);
                    console.log(`[movie] Supun fallback used: ${sPath}`);
                    return res;
                } catch (e) {
                    console.error(
                        `[movie] Supun fallback fail ${sPath} ->`,
                        e.response?.status || e.code || '',
                        JSON.stringify(e.response?.data || e.message).slice(0, 300)
                    );
                }
            }
        }
        throw lastErr || new Error('API unavailable');
    }

    socket.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

            const type = getContentType(msg.message);
            if (!msg.message) return;

            let messageContent = (type === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;

            let body = (type === 'conversation') ? messageContent.conversation
                : messageContent?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage')
                    ? messageContent.extendedTextMessage.text
                : (type === 'extendedTextMessage') ? messageContent.extendedTextMessage.text
                : (type == 'imageMessage') && messageContent.imageMessage.caption ? messageContent.imageMessage.caption
                : (type == 'videoMessage') && messageContent.videoMessage.caption ? messageContent.videoMessage.caption : '';

            let prefix = config.PREFIX || '.';
            let isCmd = body.startsWith(prefix);
            if (!isCmd) return;

            let command = body.slice(prefix.length).trim().split(' ').shift().toLowerCase();
            let args = body.trim().split(/ +/).slice(1);
            const from = msg.key.remoteJid;

            // 🎬 Generic Movie, Series, Cartoon & Anime Handler
            async function handleSiteSearch(siteName, apiPath, dlPath) {
                if (!args.length) {
                    return await socket.sendMessage(from, {
                        text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}${command} avatar\n\n📝 _Please provide Movie or Series name!_${DEFAULT_FOOTER}`
                    }, { quoted: msg });
                }

                const query = args.join(' ').trim();
                await socket.sendMessage(from, { text: `*❪ SEARCHING ❫*\n\n🔍 *Searching ${siteName} for:* _${query}_\n⚡ _Please wait a moment..._` }, { quoted: msg });

                try {
                    const res = await apiGet(apiPath, query, 30000);

                    const results = res.data?.data || res.data?.results || res.data?.result || (Array.isArray(res.data) ? res.data : []);

                    if (!results || !results.length) {
                        console.error(`[movie] ${siteName} empty results. Response:`, JSON.stringify(res.data).slice(0, 300));
                        return await socket.sendMessage(from, { text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found on ${siteName}!*${DEFAULT_FOOTER}` }, { quoted: msg });
                    }

                    let listText = `*❪ ${siteName.toUpperCase()} SEARCH RESULTS ❫*\n\n🎯 *Query:* _${query}_\n📊 *Total:* _${results.length} Items_\n\n*👇 SELECT A NUMBER 👇*\n\n`;
                    results.slice(0, 15).forEach((item, index) => {
                        const num = (index + 1) < 10 ? `0${index + 1}` : `${index + 1}`;
                        const typeIcon = (item.type === 'tvshows' || item.type === 'tv') ? '📺' : '🎥';
                        listText += `*${num}* ➜ ${typeIcon} _${(item.title || 'Movie').substring(0, 32)}_ (${getYear(item)})\n`;
                    });

                    listText += `\n📌 _Reply with the number to download!_${DEFAULT_FOOTER}`;
                    const sentMsg = await socket.sendMessage(from, { text: listText }, { quoted: msg });
                    const messageID = sentMsg.key.id;

                    const handleSelection = async ({ messages: replyMessages }) => {
                        try {
                            const replyMek = replyMessages[0];
                            if (!replyMek?.message) return;

                            const replyType = getContentType(replyMek.message);
                            const replyMsgContent = (replyType === 'ephemeralMessage') ? replyMek.message.ephemeralMessage.message : replyMek.message;

                            const messageText = replyMsgContent.conversation || replyMsgContent.extendedTextMessage?.text;
                            const isReplyToSentMsg = replyMsgContent.extendedTextMessage?.contextInfo?.stanzaId === messageID;

                            if (isReplyToSentMsg && from === replyMek.key.remoteJid) {
                                const choice = parseInt(messageText) - 1;
                                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                                    await socket.sendMessage(from, { text: `⚠️ *Invalid choice! Range: 01 - ${results.length}*` }, { quoted: replyMek });
                                    return;
                                }

                                const selectedItem = results[choice];
                                await socket.sendMessage(from, { text: `*❪ FETCHING ❫*\n\n🎬 *Fetching details from ${siteName}...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                                try {
                                    const detailsRes = await apiGet(dlPath, selectedItem.link || selectedItem.url, 60000);

                                    const movieInfo = detailsRes.data?.data || detailsRes.data?.result || detailsRes.data || {};
                                    const validDownloads = pickDownloads(movieInfo);

                                    const movieDetailsText = `*❪ MOVIE DETAILS ❫*\n\n🎬 *${movieInfo.title || selectedItem.title}*\n⭐ 𝗜𝗠🇩🇧 ➜ ★ ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n📅 𝗬𝗲𝗮𝗿 ➜ ${movieInfo.year || 'N/A'}\n⏳ 𝗗𝘂𝗿𝗮𝘁𝗶𝗼𝗻 ➜ ${movieInfo.duration || 'N/A'}\n📝 𝗦𝘁𝗼𝗿𝘆 ➜ ${movieInfo.story ? (movieInfo.story.length > 220 ? movieInfo.story.substring(0, 220) + '...' : movieInfo.story) : 'N/A'}${DEFAULT_FOOTER}`;

                                    await socket.sendMessage(from, {
                                        image: { url: movieInfo.image || movieInfo.poster || selectedItem.image || DEFAULT_IMAGE },
                                        caption: movieDetailsText
                                    }, { quoted: replyMek });

                                    if (!validDownloads || validDownloads.length === 0) {
                                        await socket.sendMessage(from, { text: `⚠️ *No Direct Downloads available for this item right now.*${DEFAULT_FOOTER}` }, { quoted: replyMek });
                                        socket.ev.off('messages.upsert', handleSelection);
                                        return;
                                    }

                                    const isSeries = apiPath.includes('/anime/')
                                        || selectedItem.type === 'tvshows' || selectedItem.type === 'tv'
                                        || validDownloads.some(d => d.episode || /\b(ep(isode)?\s*\d+|s\d+\s*e\d+)\b/i.test(String(d.title || d.quality || d.name || '')));

                                    const downloadOptionsText = `*❪ DOWNLOAD QUALITIES ❫*\n\n📥 *Select Quality:*\n\n` +
                                        validDownloads.map((dl, i) => {
                                            const num = (i + 1) < 10 ? `0${i + 1}` : `${i + 1}`;
                                            return `*${num}* ➜ 💾 _${getLabel(dl, i)}_ (${dl.size || 'Direct File'})`;
                                        }).join('\n')
                                        + (isSeries && validDownloads.length > 1 ? `\n\n*00* ➜ 📦 _Download ALL (${validDownloads.length} files)_` : '')
                                        + `\n\n📌 _Reply with the number to send file!${isSeries && validDownloads.length > 1 ? ' (0 = ALL)' : ''}_${DEFAULT_FOOTER}`;

                                    const dlSentMsg = await socket.sendMessage(from, { text: downloadOptionsText }, { quoted: replyMek });
                                    const dlMessageID = dlSentMsg.key.id;

                                    const sendAll = async (quotedMek) => {
                                        const title = movieInfo.title || selectedItem.title || 'Series';
                                        const total = validDownloads.length;
                                        await socket.sendMessage(from, {
                                            text: `*❪ SENDING ALL ❫*\n\n📦 *${total} files* upload wenawa...\n⚡ _Eka eka yanawa, tikak inna._${DEFAULT_FOOTER}`
                                        }, { quoted: quotedMek });

                                        const failed = [];
                                        let okCount = 0;

                                        for (let i = 0; i < total; i++) {
                                            const dl = validDownloads[i];
                                            const label = getLabel(dl, i);
                                            const url = getLink(dl);

                                            if (!url) {
                                                failed.push(`${i + 1}. ${label} (link nathi)`);
                                                continue;
                                            }

                                            try {
                                                await socket.sendMessage(from, { text: `📥 *${i + 1}/${total}* ➜ _${label}_` });
                                                const status = await sendVideoFile(
                                                    socket, from, url,
                                                    `${title} - ${label}.mp4`,
                                                    `*🎬 ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟 🎬*\n\n🎭 *Title:* ${title}\n📺 *Episode:* ${label}\n📊 *${i + 1}/${total}*${DEFAULT_FOOTER}`,
                                                    quotedMek
                                                );
                                                if (status === 'ok') okCount++;
                                                else failed.push(`${i + 1}. ${label}\n${url}`);
                                            } catch (e) {
                                                console.error(`Episode ${i + 1} failed:`, e.message);
                                                failed.push(`${i + 1}. ${label}\n${url}`);
                                            }
                                            await new Promise(r => setTimeout(r, 2000));
                                        }

                                        let summary = `*❪ DONE ❫*\n\n✅ *Sent:* ${okCount}/${total}`;
                                        if (failed.length) {
                                            summary += `\n\n⚠️ *Direct upload wenne nathi ewa:*\n${failed.join('\n\n')}`;
                                        }
                                        await socket.sendMessage(from, { text: summary + DEFAULT_FOOTER }, { quoted: quotedMek });
                                    };

                                    const handleDownloadSelection = async ({ messages: dlReplyMessages }) => {
                                        try {
                                            const dlReplyMek = dlReplyMessages[0];
                                            if (!dlReplyMek?.message) return;
                                            const dlReplyType = getContentType(dlReplyMek.message);
                                            const dlReplyContent = (dlReplyType === 'ephemeralMessage') ? dlReplyMek.message.ephemeralMessage.message : dlReplyMek.message;

                                            const dlChoiceText = dlReplyContent.conversation || dlReplyContent.extendedTextMessage?.text;
                                            const isReplyToDlMsg = dlReplyContent.extendedTextMessage?.contextInfo?.stanzaId === dlMessageID;

                                            if (isReplyToDlMsg && from === dlReplyMek.key.remoteJid) {
                                                const rawChoice = String(dlChoiceText || '').trim();
                                                if (isSeries && validDownloads.length > 1 && /^0+$/.test(rawChoice)) {
                                                    socket.ev.off('messages.upsert', handleDownloadSelection);
                                                    await sendAll(dlReplyMek);
                                                    return;
                                                }

                                                const dlChoice = parseInt(dlChoiceText) - 1;
                                                if (isNaN(dlChoice) || dlChoice < 0 || dlChoice >= validDownloads.length) return;

                                                socket.ev.off('messages.upsert', handleDownloadSelection);

                                                const selectedDownload = validDownloads[dlChoice];
                                                const fileUrl = getLink(selectedDownload);

                                                if (!fileUrl) {
                                                    await socket.sendMessage(from, { text: `⚠️ *Download URL could not be retrieved.*${DEFAULT_FOOTER}` }, { quoted: dlReplyMek });
                                                    return;
                                                }

                                                await socket.sendMessage(from, { text: `*❪ SENDING MOVIE ❫*\n\n📥 *Sending:* _${movieInfo.title || selectedItem.title}_\n📊 *Quality:* _${selectedDownload.quality || 'HD'}_\n⚡ _Uploading file to WhatsApp..._` }, { quoted: dlReplyMek });

                                                let tmpFile = null;
                                                try {
                                                    tmpFile = await fetchToTmp(fileUrl);

                                                    if (!tmpFile) {
                                                        await socket.sendMessage(from, {
                                                            text: `⚠️ *Direct MP4 link ekak nemei.*\n\n🔗 *Download Link:*\n${fileUrl}${DEFAULT_FOOTER}`
                                                        }, { quoted: dlReplyMek });
                                                    } else {
                                                        const sizeMB = fs.statSync(tmpFile).size / 1024 / 1024;
                                                        if (sizeMB > 1900) {
                                                            await socket.sendMessage(from, {
                                                                text: `⚠️ *File eka WhatsApp limit ekata wada loku (${sizeMB.toFixed(0)}MB).*\n\n🔗 ${fileUrl}${DEFAULT_FOOTER}`
                                                            }, { quoted: dlReplyMek });
                                                        } else {
                                                            await socket.sendMessage(from, {
                                                                document: { url: tmpFile },
                                                                mimetype: 'video/mp4',
                                                                fileName: `${movieInfo.title || 'Movie'} (${selectedDownload.quality || 'HD'}).mp4`,
                                                                caption: `*🎬 ✨ 𝙈𝘼🇱I𝙔𝘼 𝘾I🇱🇰𝙈𝘼 🍟 🎬*\n\n🎭 *Title:* ${movieInfo.title || selectedItem.title}\n📊 *Quality:* ${selectedDownload.quality || 'HD'}\n💾 *Size:* ${selectedDownload.size || 'Direct'}${DEFAULT_FOOTER}`
                                                            }, { quoted: dlReplyMek });
                                                        }
                                                    }
                                                } catch (sendErr) {
                                                    console.error('Send Error:', sendErr.message);
                                                    await socket.sendMessage(from, { text: `⚠️ *Upload failed! Link:* ${fileUrl}${DEFAULT_FOOTER}` }, { quoted: dlReplyMek });
                                                } finally {
                                                    if (tmpFile && fs.existsSync(tmpFile)) fs.unlink(tmpFile, () => {});
                                                }
                                            }
                                        } catch (e) {
                                            console.error("DL Selection Error:", e);
                                        }
                                    };
                                    socket.ev.on('messages.upsert', handleDownloadSelection);
                                } catch (err) {
                                    console.error("Info Error Details:", err?.response?.data || err.message);
                                    await socket.sendMessage(from, { text: `⚠️ *Details fetch failed (${errTag(err)}). Try again later.*${DEFAULT_FOOTER}` }, { quoted: replyMek });
                                }
                                socket.ev.off('messages.upsert', handleSelection);
                            }
                        } catch (e) {
                            console.error("Selection Error:", e);
                        }
                    };
                    socket.ev.on('messages.upsert', handleSelection);
                } catch (err) {
                    console.error("Search Error Details:", err?.response?.status, err?.response?.data || err.message);
                    await socket.sendMessage(from, { text: `⚠️ *Search failed (${errTag(err)}). Try again later.*${DEFAULT_FOOTER}` }, { quoted: msg });
                }
            }

            // Command Switch List
            switch (command) {
                case 'baiscope':
                case 'bs':
                    await handleSiteSearch('Baiscope.lk', '/api/v1/movie/baiscope/search', '/api/v1/movie/baiscope/infodl');
                    break;

                case 'lksub':
                case 'ls':
                    await handleSiteSearch('LKSub.com', '/api/v1/movie/lksub/search', '/api/v1/movie/lksub/infodl');
                    break;

                case 'sinhalasub':
                case 'ss':
                    await handleSiteSearch('SinhalaSub.lk', '/api/v1/movie/sinhalasub/search', '/api/v1/movie/sinhalasub/infodl');
                    break;

                case 'thenkiri':
                case 'tk':
                    await handleSiteSearch('Thenkiri', '/api/v1/movie/thenkiri/search', '/api/v1/movie/thenkiri/infodl');
                    break;

                case 'cinesubz':
                case 'cine':
                case 'cs':
                    await handleSiteSearch('CineSubz', '/api/v1/movie/cinesubz/search', '/api/v1/movie/cinesubz/infodl');
                    break;

                case 'cineru':
                case 'cr':
                    await handleSiteSearch('Cineru.lk', '/api/v1/movie/cineru/search', '/api/v1/movie/cineru/infodl');
                    break;

                case 'dinkamovies':
                case 'dm':
                    await handleSiteSearch('DinkaMovies', '/api/v1/movie/dinkamovies/search', '/api/v1/movie/dinkamovies/infodl');
                    break;

                case 'sinhalacartoons':
                case 'sc':
                    await handleSiteSearch('SinhalaCartoons', '/api/v1/movie/sinhalacartoons/search', '/api/v1/movie/sinhalacartoons/infodl');
                    break;

                case 'chithrapata':
                case 'cp':
                    await handleSiteSearch('Chithrapata.com', '/api/v1/chithrapata/search', '/api/v1/chithrapata/infodl');
                    break;

                case 'animeheaven':
                case 'ah':
                    await handleSiteSearch('AnimeHeaven', '/api/v1/anime/animeheaven/search', '/api/v1/anime/animeheaven/infodl');
                    break;

                case 'subtitle':
                case 'subcat':
                case 'sub': {
                    if (!args.length) {
                        return socket.sendMessage(from, { text: `❌ Movie/Series නමක් ලබා දෙන්න.\n\nEx: *${prefix}${command} avengers*` }, { quoted: msg });
                    }
                    const query = args.join(" ");
                    try {
                        await socket.sendMessage(from, { react: { text: '🔎', key: msg.key } });
                        const apiUrl = `https://supunofc.site/api/movie/subcat/search?q=${encodeURIComponent(query)}&apikey=${config.SUPUN_API_KEY}`;
                        const { data } = await axios.get(apiUrl, { timeout: 30000 });

                        if (!data.success || !data.result || data.result.length === 0) {
                            return socket.sendMessage(from, { text: '❌ Subtitles කිසිවක් හමු නොවීය.' }, { quoted: msg });
                        }

                        const blocked = /porn|xxx|anal|sex|milf|blowjob|fc2ppv|jav|nuru|threesome|bigtits|nsfw/i;
                        const results = data.result.filter(v => !blocked.test(v.title)).slice(0, 10);

                        if (results.length === 0) {
                            return socket.sendMessage(from, { text: '❌ Subtitles කිසිවක් හමු නොවීය.' }, { quoted: msg });
                        }

                        let subMsg = `🎬 *SUBTITLE SEARCH*\n\n🔍 *Query:* ${data.query}\n\n`;
                        results.forEach((v, i) => {
                            subMsg += `*${i + 1}. ${v.title}*\n📦 Size: ${v.fileSize}\n⬇️ ${v.downloads}\n🌐 ${v.languagesCount}\n🔗 ${v.url}\n\n`;
                        });
                        subMsg += DEFAULT_FOOTER;

                        await socket.sendMessage(from, { text: subMsg }, { quoted: msg });
                        await socket.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(from, { text: '❌ Error එකක් ආවා, පසුව උත්සාහ කරන්න.' }, { quoted: msg });
                    }
                    break;
                }
            }
        } catch (err) {
            console.error("Movie Handler Error:", err);
        }
    });
}

module.exports = registerMovieCommands;
