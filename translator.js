require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

// === КОНФИГУРАЦИЯ ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY;

if (!OPENAI_API_KEY || !ASSEMBLYAI_KEY) {
  console.error('❌ OPENAI_API_KEY or ASSEMBLYAI_KEY not set in .env');
  process.exit(1);
}

const SETTINGS_FILE = path.join(__dirname, 'translator_settings.json');
const AUTH_DIR = path.join(__dirname, '.baileys_auth');
const MY_LANG = 'ru';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === НАСТРОЙКИ PER-CHAT ===
let chatSettings = {};

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      chatSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      console.log(`Загружено ${Object.keys(chatSettings).length} настроек чатов`);
    } catch (e) {
      console.error('[!] translator_settings.json повреждён, чистый старт');
      chatSettings = {};
    }
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(chatSettings, null, 2));
}

// === ОПРЕДЕЛЕНИЕ ЯЗЫКА ===
function detectLanguage(text) {
  if (!text) return 'en';
  const cyrillic = [...text].filter(c => c >= 'Ѐ' && c <= 'ӿ').length;
  const total = text.replace(/\s/g, '').length;
  if (total === 0) return 'en';
  if (cyrillic / total > 0.3) return 'ru';
  return 'unknown';
}

// === ТРАНСКРИПЦИЯ АУДИО (AssemblyAI primary + Whisper fallback) ===
async function transcribeAudio(filePath) {
  try {
    console.log(`  [aai] Транскрибация: ${filePath}`);

    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'authorization': ASSEMBLYAI_KEY },
      body: fs.readFileSync(filePath)
    });
    const { upload_url } = await uploadResp.json();

    const txResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: upload_url,
        language_detection: true,
        speech_models: ['universal-3-pro', 'universal-2']
      })
    });
    const tx = await txResp.json();
    if (!tx.id) throw new Error(tx.error || 'No transcript ID');

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollResp = await fetch('https://api.assemblyai.com/v2/transcript/' + tx.id, {
        headers: { 'authorization': ASSEMBLYAI_KEY }
      });
      const result = await pollResp.json();
      if (result.status === 'completed') {
        const lang = result.language_code || detectLanguage(result.text);
        console.log(`  [aai] OK: "${result.text?.substring(0, 80)}..." (${lang})`);
        return { text: result.text, lang };
      }
      if (result.status === 'error') throw new Error(result.error);
    }
    throw new Error('Timeout');
  } catch (err) {
    console.error(`  [aai] Ошибка: ${err.message}, fallback на Whisper`);
  }

  console.log(`  [whisper] Fallback транскрибация...`);
  const audioFile = fs.createReadStream(filePath);
  const response = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: audioFile,
    response_format: 'verbose_json'
  });
  const lang = response.language || 'en';
  console.log(`  [whisper] OK: "${response.text?.substring(0, 80)}..." (${lang})`);
  return { text: response.text, lang };
}

// === ПЕРЕВОД ЧЕРЕЗ GPT ===
async function translateText(text, sourceLang, targetLang) {
  const langNames = {
    ru: 'Russian', en: 'English', id: 'Indonesian', th: 'Thai',
    zh: 'Chinese', ja: 'Japanese', ko: 'Korean', fr: 'French',
    de: 'German', es: 'Spanish', pt: 'Portuguese', ar: 'Arabic',
    hi: 'Hindi', vi: 'Vietnamese', ms: 'Malay', tr: 'Turkish'
  };

  const tgtName = langNames[targetLang] || targetLang;
  const autoDetect = sourceLang === 'auto' || sourceLang === 'unknown' || !sourceLang;

  try {
    const systemPrompt = autoDetect
      ? `You are a professional translator. Detect the language of the input and translate it to ${tgtName}. Add 1-3 fitting emoji inside the translation where they naturally fit the meaning (do not overdo). Return JSON: {"detected_language": "ISO code (ru/en/id/th/de/etc)", "translation": "translated text with emoji"}. No explanations.`
      : `You are a professional translator. Translate from ${langNames[sourceLang] || sourceLang} to ${tgtName}. Add 1-3 fitting emoji inside the translation where they naturally fit the meaning (do not overdo). Return JSON: {"detected_language": "${sourceLang}", "translation": "translated text with emoji"}. No explanations.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 2000
    });

    const raw = response.choices[0].message.content.trim();
    try {
      const parsed = JSON.parse(raw);
      return {
        text: (parsed.translation || raw).trim(),
        detectedLang: (parsed.detected_language || sourceLang || 'unknown').toLowerCase()
      };
    } catch (parseErr) {
      return { text: raw, detectedLang: sourceLang || 'unknown' };
    }
  } catch (err) {
    console.error(`  [gpt] Ошибка перевода: ${err.message}`);
    return { text: `[Translation error: ${err.message}]`, detectedLang: 'error' };
  }
}

// === TTS (ОЗВУЧКА) ===
async function generateAudio(text, lang) {
  const instructions = {
    ru: 'Speak clearly in Russian with native pronunciation.',
    en: 'Speak clearly in English with native pronunciation.',
    id: 'Speak clearly in Indonesian with native pronunciation.',
    th: 'Speak clearly in Thai with native pronunciation.',
  };

  const response = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: 'onyx',
    input: text,
    instructions: instructions[lang] || 'Speak clearly with native pronunciation.'
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, buffer);
  return tmpFile;
}

// === HELPERS: JID + СООБЩЕНИЯ ===

// Извлечь текст из Baileys message
function extractText(msg) {
  return msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || msg.message?.videoMessage?.caption
      || '';
}

// Какое медиа в сообщении (если есть audio/ptt/video — для транскрипции)
function getAudioMedia(msg) {
  return msg.message?.audioMessage
      || msg.message?.pttMessage
      || msg.message?.videoMessage
      || null;
}

// Нормализация JID для поиска в settings (по номеру без суффикса)
function getChatSettingsForId(chatId) {
  if (chatSettings[chatId]) return chatSettings[chatId];
  // Старые wwjs ключи: 1234@c.us; новые Baileys: 1234@s.whatsapp.net; @lid тоже бывает
  const num = chatId.replace(/@.*$/, '').replace(/:\d+$/, '');
  for (const [key, val] of Object.entries(chatSettings)) {
    const keyNum = key.replace(/@.*$/, '').replace(/:\d+$/, '');
    if (keyNum === num) return val;
  }
  return null;
}

// === ОБРАБОТКА КОМАНД В ЧАТЕ ===
function isCommand(body) {
  return body && body.startsWith('#');
}

async function handleCommand(sock, msg, body) {
  const chatId = msg.key.remoteJid;
  const cmd = body.trim().toLowerCase();

  if (cmd === '#translate' || cmd.startsWith('#translate ')) {
    const parts = cmd.split(' ');
    const lang = parts[1] || 'en';
    chatSettings[chatId] = { enabled: true, targetLang: lang, tts: false };
    saveSettings();
    await sock.sendMessage(chatId, {
      text: `🌐 Translator ON\n→ Your messages will be translated to: ${lang}\n→ Incoming messages → Russian\n\nCommands: #stop, #tts on, #status`
    }, { quoted: msg });
    console.log(`[+] Переводчик ВКЛ для ${chatId} (→${lang})`);
    return true;
  }

  if (cmd === '#stop') {
    if (chatSettings[chatId]) {
      chatSettings[chatId].enabled = false;
      saveSettings();
    }
    await sock.sendMessage(chatId, { text: '🔴 Translator OFF' }, { quoted: msg });
    console.log(`[-] Переводчик ВЫКЛ для ${chatId}`);
    return true;
  }

  if (cmd === '#tts on') {
    const s = chatSettings[chatId] || getChatSettingsForId(chatId);
    if (s) {
      s.tts = true;
      chatSettings[chatId] = s;
      saveSettings();
      await sock.sendMessage(chatId, { text: '🔊 TTS ON — переводы будут озвучиваться' }, { quoted: msg });
    }
    return true;
  }

  if (cmd === '#tts off') {
    const s = chatSettings[chatId] || getChatSettingsForId(chatId);
    if (s) {
      s.tts = false;
      chatSettings[chatId] = s;
      saveSettings();
      await sock.sendMessage(chatId, { text: '🔇 TTS OFF' }, { quoted: msg });
    }
    return true;
  }

  if (cmd === '#status') {
    const s = getChatSettingsForId(chatId);
    if (s && s.enabled) {
      await sock.sendMessage(chatId, {
        text: `🌐 Translator: ON\n🎯 Target lang: ${s.targetLang}\n🔊 TTS: ${s.tts ? 'ON' : 'OFF'}`
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: '🔴 Translator: OFF\nSend #translate to enable'
      }, { quoted: msg });
    }
    return true;
  }

  return false;
}

// === ДЕБАУНС И ОЧЕРЕДЬ ===
const processingChats = new Set();
const recentlyTranslated = new Map();

function isDuplicate(chatId, text) {
  const key = `${chatId}:${(text || '').substring(0, 50)}`;
  const now = Date.now();
  if (recentlyTranslated.has(key) && now - recentlyTranslated.get(key) < 30000) {
    return true;
  }
  recentlyTranslated.set(key, now);
  if (recentlyTranslated.size > 100) {
    for (const [k, v] of recentlyTranslated) {
      if (now - v > 60000) recentlyTranslated.delete(k);
    }
  }
  return false;
}

// === ОБРАБОТКА ВХОДЯЩЕГО (от собеседника) ===
async function processIncoming(sock, msg, settings) {
  const chatId = msg.key.remoteJid;
  let text = extractText(msg);
  let detectedLang = '';
  const audioMedia = getAudioMedia(msg);

  // Аудио/голосовое/кружочек → транскрипция
  if (audioMedia) {
    const tmpFile = path.join(os.tmpdir(), `wa_audio_${Date.now()}.ogg`);
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        reuploadRequest: sock.updateMediaMessage
      });
      fs.writeFileSync(tmpFile, buffer);

      console.log(`[<<] Аудио от ${chatId}, транскрибация...`);
      const result = await transcribeAudio(tmpFile);
      text = result.text;
      detectedLang = result.lang;

      if (!text || !text.trim()) {
        console.log('  [!] Пустая транскрипция, пропускаем');
        return;
      }
      console.log(`  [aai] Транскрипция: "${text.substring(0, 100)}..." (${detectedLang})`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
  }

  if (!text || !text.trim()) return;

  if (!detectedLang) detectedLang = detectLanguage(text);

  // Нормализация
  if (detectedLang === 'russian') detectedLang = 'ru';
  if (detectedLang === 'english') detectedLang = 'en';
  if (detectedLang === 'indonesian') detectedLang = 'id';

  // Переводим на русский если не русский
  if (detectedLang !== MY_LANG && detectedLang !== 'unknown') {
    const tr = await translateText(text, detectedLang, MY_LANG);
    const translation = tr.text;
    detectedLang = tr.detectedLang || detectedLang;

    const replyText = audioMedia
      ? `📝 [${detectedLang.toUpperCase()}]: ${text}\n\n🌐 [RU]: ${translation}`
      : `🌐 [RU]: ${translation}`;

    await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
    console.log(`[<<] Перевод входящего (${detectedLang}→ru): ${translation.substring(0, 80)}`);

    if (settings.tts) {
      try {
        const audioPath = await generateAudio(translation, MY_LANG);
        const audioBuffer = fs.readFileSync(audioPath);
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mp4',
          ptt: true
        });
        try { fs.unlinkSync(audioPath); } catch (e) {}
      } catch (ttsErr) {
        console.error(`  [tts] Ошибка озвучки: ${ttsErr.message}`);
      }
    }
  } else if (detectedLang === 'unknown') {
    const tr = await translateText(text, 'auto', MY_LANG);
    const translation = tr.text;
    const actualLang = tr.detectedLang || 'auto';
    await sock.sendMessage(chatId, {
      text: `📝 [${actualLang.toUpperCase()}]: ${text}\n\n🌐 [RU]: ${translation}`
    }, { quoted: msg });
    console.log(`[<<] Перевод (${actualLang}→ru): ${translation.substring(0, 80)}`);
  }
}

// === ОБРАБОТКА ИСХОДЯЩЕГО (моё сообщение) ===
async function processOutgoing(sock, msg, settings) {
  const chatId = msg.key.remoteJid;
  const text = extractText(msg);
  const audioMedia = getAudioMedia(msg);

  // Не переводим если это уже перевод от бота
  if (text && (text.startsWith('🌐') || text.startsWith('📝'))) return;

  // Моё аудио → транскрипция + перевод на язык чата
  if (audioMedia) {
    const tmpFile = path.join(os.tmpdir(), `wa_my_audio_${Date.now()}.ogg`);
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        reuploadRequest: sock.updateMediaMessage
      });
      fs.writeFileSync(tmpFile, buffer);

      console.log(`[>>] Моё аудио, транскрибация...`);
      const result = await transcribeAudio(tmpFile);

      if (result.text && result.text.trim()) {
        const tr = await translateText(result.text, result.lang || 'ru', settings.targetLang);
        let translation = tr.text.replace(/\.$/, '');
        await sock.sendMessage(chatId, { text: `🌐 ${translation}` });
        console.log(`[>>] Моё аудио (${result.lang}→${settings.targetLang}): ${translation.substring(0, 80)}`);
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
    return;
  }

  // Мой текст на русском → перевод и edit (или новое сообщение если edit не сработал)
  if (text && text.trim()) {
    const sourceLang = detectLanguage(text);
    if (sourceLang === MY_LANG) {
      const tr = await translateText(text, 'ru', settings.targetLang);
      let translation = tr.text.replace(/\.$/, '');

      // Baileys: edit работает везде, включая @lid
      try {
        await sock.sendMessage(chatId, { text: translation, edit: msg.key });
        console.log(`[>>] EDIT (ru→${settings.targetLang}): ${translation.substring(0, 80)}`);
      } catch (editErr) {
        // Если edit не сработал — отправляем новое сообщение
        await sock.sendMessage(chatId, { text: `🌐 ${translation}` });
        console.log(`[>>] Мой текст (ru→${settings.targetLang}, edit fail): ${translation.substring(0, 80)}`);
      }
    }
  }
}

// === ROUTER: единая точка входа для всех сообщений ===
async function routeMessage(sock, msg) {
  if (!msg.message) return;
  if (msg.key.remoteJid === 'status@broadcast') return;
  if (msg.key.remoteJid?.endsWith('@g.us')) return; // игнорируем группы

  const chatId = msg.key.remoteJid;
  const text = extractText(msg);

  // Команды (от меня или в этом чате)
  if (text && isCommand(text)) {
    // Команды разрешены только мне (fromMe) или в личке если бот один там
    if (msg.key.fromMe) {
      await handleCommand(sock, msg, text);
      return;
    }
  }

  const settings = getChatSettingsForId(chatId);
  if (!settings || !settings.enabled) return;

  // Дебаунс
  if (text && isDuplicate(chatId, text)) {
    console.log(`  [skip] Дубль от ${chatId}`);
    return;
  }

  // Защита от параллельной обработки
  const lockKey = chatId + (msg.key.fromMe ? '_out' : '_in');
  if (processingChats.has(lockKey)) return;
  processingChats.add(lockKey);

  try {
    if (msg.key.fromMe) {
      await processOutgoing(sock, msg, settings);
    } else {
      await processIncoming(sock, msg, settings);
    }
  } catch (err) {
    console.error(`[!] Ошибка обработки: ${err.message}`);
  } finally {
    processingChats.delete(lockKey);
  }
}

// === ПОДКЛЮЧЕНИЕ К WHATSAPP (Baileys) ===
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000];
let isReconnecting = false;

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Baileys WA Web v${version.join('.')} (latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Translator', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== СКАНИРУЙ QR КОД ===\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWhatsApp → Настройки → Связанные устройства → Привязать устройство\n');
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reasonName = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === code) || `code ${code}`;
      console.log(`[!] Отключён. Причина: ${reasonName} (${code})`);

      // LOGGED OUT / forbidden / badSession — не реконнектим, эскалирует
      if (code === DisconnectReason.loggedOut
          || code === DisconnectReason.forbidden
          || code === DisconnectReason.badSession) {
        console.log('[!] WhatsApp выкинул сессию. Удали .baileys_auth/ и пересканируй QR.');
        setTimeout(() => process.exit(1), 500);
        return;
      }

      if (isReconnecting) return;

      // restartRequired (515) / timedOut / connectionLost — требуют МГНОВЕННОГО реконнекта
      // (если ждать долго, WhatsApp сбрасывает state и присылает loggedOut)
      const isFastReconnect =
        code === DisconnectReason.restartRequired
        || code === DisconnectReason.timedOut
        || code === DisconnectReason.connectionLost
        || code === DisconnectReason.connectionClosed;

      if (isFastReconnect) {
        isReconnecting = true;
        console.log(`[~] Быстрый реконнект через 1.5s (${reasonName})`);
        setTimeout(() => {
          isReconnecting = false;
          connectWhatsApp().catch(err => {
            console.error('[!] Ошибка реконнекта:', err.message);
            setTimeout(() => process.exit(1), 500);
          });
        }, 1500);
        return;
      }

      // Прочие причины — exponential backoff
      if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[!] Достигнут лимит реконнектов (${MAX_RECONNECT_ATTEMPTS}). Выхожу.`);
        setTimeout(() => process.exit(1), 500);
        return;
      }
      isReconnecting = true;
      const delay = BACKOFF_MS[reconnectAttempt];
      reconnectAttempt++;
      console.log(`[~] Попытка реконнекта ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} через ${delay/1000}s`);
      setTimeout(() => {
        isReconnecting = false;
        connectWhatsApp().catch(err => {
          console.error('[!] Ошибка реконнекта:', err.message);
          setTimeout(() => process.exit(1), 500);
        });
      }, delay);
    } else if (connection === 'open') {
      reconnectAttempt = 0;
      console.log('\n=== WhatsApp Translator подключён! ===\n');
      console.log(`Мой ID: ${sock.user?.id}`);
      console.log(`Имя: ${sock.user?.name || '—'}\n`);
      console.log('Команды в чате:');
      console.log('  #translate      — включить переводчик');
      console.log('  #translate en   — включить + язык ответов');
      console.log('  #stop           — выключить');
      console.log('  #tts on/off     — озвучка');
      console.log('  #status         — настройки чата\n');
      console.log('Терминал:');
      console.log('  status          — все чаты с переводом');
      console.log('  quit            — выход\n');
      if (process.stdin.isTTY) promptUser();
    }
  });

  // Главный обработчик сообщений
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' — реальное время; 'append' — догрузка пропущенных при reconnect (catchup)
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try {
        await routeMessage(sock, msg);
      } catch (err) {
        console.error(`[!] routeMessage error: ${err.message}`);
      }
    }
  });

  return sock;
}

// === ТЕРМИНАЛ ===
let rl;
let currentSock = null;
if (process.stdin.isTTY) {
  const readline = require('readline');
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function promptUser() {
  if (!rl) return;
  rl.question('translator> ', async (input) => {
    const cmd = input.trim();
    if (!cmd) { promptUser(); return; }
    switch (cmd) {
      case 'status':
        console.log('\n=== ЧАТЫ С ПЕРЕВОДОМ ===\n');
        const enabled = Object.entries(chatSettings).filter(([_, s]) => s.enabled);
        if (enabled.length === 0) {
          console.log('Нет активных. Отправь #translate в любом чате.\n');
        } else {
          for (const [id, s] of enabled) {
            console.log(`  ${id} → ${s.targetLang} | TTS: ${s.tts ? 'ON' : 'OFF'}`);
          }
          console.log('');
        }
        break;
      case 'quit':
      case 'exit':
        console.log('Выход...');
        saveSettings();
        if (currentSock) { try { await currentSock.end(); } catch (e) {} }
        process.exit(0);
      default:
        console.log('Команды: status, quit');
    }
    if (process.stdin.isTTY) promptUser();
  });
}

// === ЗАПУСК ===
console.log('=== WhatsApp Translator (Baileys) ===');
console.log('AssemblyAI + GPT + TTS\n');

loadSettings();

process.on('unhandledRejection', (err) => {
  console.error('[!] Unhandled rejection:', err?.message || err);
  setTimeout(() => process.exit(1), 100);
});

console.log('Подключение к WhatsApp...\n');
connectWhatsApp()
  .then(sock => { currentSock = sock; })
  .catch(err => {
    console.error('[!] Ошибка запуска:', err);
    process.exit(1);
  });
