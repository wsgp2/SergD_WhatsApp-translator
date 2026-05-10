require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// === КОНФИГУРАЦИЯ ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY;

if (!OPENAI_API_KEY || !ASSEMBLYAI_KEY) {
  console.error('❌ OPENAI_API_KEY or ASSEMBLYAI_KEY not set in .env');
  process.exit(1);
}

const SETTINGS_FILE = path.join(__dirname, 'translator_settings.json');
const MY_LANG = 'ru'; // Мой язык — русский

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === НАСТРОЙКИ PER-CHAT ===
let chatSettings = {}; // chatId -> { enabled: true, targetLang: 'en', tts: false }

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
  return 'unknown'; // GPT определит точнее при переводе
}

// === ТРАНСКРИПЦИЯ АУДИО (AssemblyAI primary + Whisper fallback) ===
async function transcribeAudio(filePath) {
  // AssemblyAI через REST API (SDK глючит с speech_models)
  try {
    console.log(`  [aai] Транскрибация: ${filePath}`);

    // Upload
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'authorization': ASSEMBLYAI_KEY },
      body: fs.readFileSync(filePath)
    });
    const { upload_url } = await uploadResp.json();

    // Transcribe
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

    // Poll до готовности (макс 60 сек)
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

  // Whisper fallback
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
  const tmpFile = path.join(require('os').tmpdir(), `tts_${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, buffer);
  return tmpFile;
}

// === WHATSAPP CLIENT ===
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: "/usr/bin/brave-browser",
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--disable-extensions', '--single-process',
           '--disable-blink-features=AutomationControlled',
           '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36']
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
  },
  webVersion: '2.3000.1039092809-alpha',
  restartOnAuthFail: true
});

let reconnecting = false;

client.on('qr', (qr) => {
  console.log('\n=== СКАНИРУЙ QR КОД ===\n');
  qrcode.generate(qr, { small: true });
});

client.on('auth_failure', (msg) => {
  console.log(`[!] Auth failed: ${msg}. Удали .wwebjs_auth/ и пересканируй.`);
});

// Exponential backoff против reconnect-storm (триггерит WhatsApp LOGOUT)
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000]; // 30s, 1m, 2m, 5m, 15m

client.on('disconnected', (reason) => {
  const reasonStr = String(reason || '');
  console.log(`[!] Отключён: ${reasonStr}`);

  // LOGOUT/UNPAIRED — это решение сервера, retry → ban escalation
  if (/LOGOUT|UNPAIRED|FORBIDDEN/i.test(reasonStr)) {
    console.log('[!] WhatsApp выкинул сессию принудительно. Не реконнекчусь — это эскалирует бан.');
    console.log('[!] Удали .wwebjs_auth/ и пересканируй QR. systemd подхватит на старте.');
    setTimeout(() => process.exit(1), 500);
    return;
  }

  if (reconnecting) return;
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.log(`[!] Достигнут лимит реконнектов (${MAX_RECONNECT_ATTEMPTS}). Выхожу, systemd рестартует с задержкой.`);
    setTimeout(() => process.exit(1), 500);
    return;
  }
  reconnecting = true;
  const delay = BACKOFF_MS[reconnectAttempt];
  reconnectAttempt++;
  console.log(`[~] Попытка реконнекта ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} через ${delay/1000}s`);
  setTimeout(() => {
    reconnecting = false;
    client.initialize();
  }, delay);
});

// При успешном ready сбрасываем счётчик попыток
client.on('ready', () => { reconnectAttempt = 0; });

client.on('ready', async () => {
  console.log('\n=== WhatsApp Translator подключён! ===\n');

  // Catchup пропущенных
  await catchUpTranslations();

  console.log('Команды в чате:');
  console.log('  #translate      — включить переводчик');
  console.log('  #translate en   — включить + язык ответов');
  console.log('  #stop           — выключить');
  console.log('  #tts on/off     — озвучка');
  console.log('  #status         — настройки чата\n');

  console.log('Терминал:');
  console.log('  status          — все чаты с переводом');
  console.log('  quit            — выход\n');
  if (process.stdin.isTTY) { promptUser(); }
});

// === ОБРАБОТКА КОМАНД В ЧАТЕ ===
function isCommand(body) {
  return body && body.startsWith('#');
}

async function handleCommand(msg) {
  const body = msg.body.trim().toLowerCase();
  const chatId = msg.from;

  if (body === '#translate' || body.startsWith('#translate ')) {
    const parts = body.split(' ');
    const lang = parts[1] || 'en';
    chatSettings[chatId] = { enabled: true, targetLang: lang, tts: false };
    saveSettings();
    await msg.reply(`🌐 Translator ON\n→ Your messages will be translated to: ${lang}\n→ Incoming messages → Russian\n\nCommands: #stop, #tts on, #status`);
    console.log(`[+] Переводчик ВКЛ для ${chatId} (→${lang})`);
    return true;
  }

  if (body === '#stop') {
    if (chatSettings[chatId]) {
      chatSettings[chatId].enabled = false;
      saveSettings();
    }
    await msg.reply('🔴 Translator OFF');
    console.log(`[-] Переводчик ВЫКЛ для ${chatId}`);
    return true;
  }

  if (body === '#tts on') {
    const s = chatSettings[chatId] || getChatSettingsForId(chatId);
    if (s) {
      s.tts = true;
      chatSettings[chatId] = s;
      saveSettings();
      await msg.reply('🔊 TTS ON — переводы будут озвучиваться');
    }
    return true;
  }

  if (body === '#tts off') {
    const s = chatSettings[chatId] || getChatSettingsForId(chatId);
    if (s) {
      s.tts = false;
      chatSettings[chatId] = s;
      saveSettings();
      await msg.reply('🔇 TTS OFF');
    }
    return true;
  }

  if (body === '#status') {
    const s = getChatSettingsForId(chatId);
    if (s && s.enabled) {
      await msg.reply(`🌐 Translator: ON\n🎯 Target lang: ${s.targetLang}\n🔊 TTS: ${s.tts ? 'ON' : 'OFF'}`);
    } else {
      await msg.reply('🔴 Translator: OFF\nSend #translate to enable');
    }
    return true;
  }

  return false;
}

// === ОБРАБОТКА СООБЩЕНИЙ ===
const processingChats = new Set();
const recentlyTranslated = new Map(); // дебаунс: chatId -> timestamp

function isDuplicate(chatId, text) {
  const key = `${chatId}:${(text || '').substring(0, 50)}`;
  const now = Date.now();
  if (recentlyTranslated.has(key) && now - recentlyTranslated.get(key) < 30000) {
    return true; // тот же текст за последние 30 сек — дубль
  }
  recentlyTranslated.set(key, now);
  // Чистим старые записи
  if (recentlyTranslated.size > 100) {
    for (const [k, v] of recentlyTranslated) {
      if (now - v > 60000) recentlyTranslated.delete(k);
    }
  }
  return false;
}

// Получить chatId для поиска настроек (поддержка @c.us и @lid)
function getChatSettingsForId(chatId) {
  if (chatSettings[chatId]) return chatSettings[chatId];
  // Пробуем найти по номеру без суффикса
  const num = chatId.replace(/@.*$/, '');
  for (const [key, val] of Object.entries(chatSettings)) {
    if (key.replace(/@.*$/, '') === num) return val;
  }
  return null;
}

client.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;
  if (msg.fromMe) return;

  const chatId = msg.from;
  const settings = getChatSettingsForId(chatId);

  if (!settings || !settings.enabled) return;
  if (!msg.body && !msg.hasMedia) return;

  // Дебаунс — не переводим дубли
  if (isDuplicate(chatId, msg.body)) {
    console.log(`  [skip] Дубль от ${chatId}`);
    return;
  }

  // Защита от параллельной обработки одного чата
  if (processingChats.has(chatId)) return;
  processingChats.add(chatId);

  try {
    await processMessage(msg, settings);
  } catch (err) {
    console.error(`[!] Ошибка обработки: ${err.message}`);
  } finally {
    processingChats.delete(chatId);
  }
});

// Исходящие сообщения (мои)
client.on('message_create', async (msg) => {
  if (!msg.fromMe) return;

  const chatId = msg.to;

  // Команды от меня — обрабатываем
  if (msg.body && isCommand(msg.body)) {
    // Подменяем msg.from на chatId для handleCommand
    const origFrom = msg.from;
    msg.from = chatId;
    await handleCommand(msg);
    msg.from = origFrom;
    return;
  }

  const settings = getChatSettingsForId(chatId);
  if (!settings || !settings.enabled) return;

  // Не переводим если это уже перевод от бота или отредактированное
  if (msg.body && (msg.body.startsWith('🌐') || msg.body.startsWith('📝'))) return;
  if (msg.latestEditSenderTimestampMs) return; // пропускаем edited сообщения

  // Защита от параллельной обработки
  if (processingChats.has(chatId + '_out')) return;
  processingChats.add(chatId + '_out');

  try {
    // Моё аудио → транскрипция + перевод на язык чата
    if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'ptt' || msg.type === 'video')) {
      const media = await msg.downloadMedia();
      if (media) {
        const tmpFile = path.join(require('os').tmpdir(), `wa_my_audio_${Date.now()}.ogg`);
        fs.writeFileSync(tmpFile, Buffer.from(media.data, 'base64'));

        console.log(`[>>] Моё аудио, транскрибация...`);
        const result = await transcribeAudio(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (e) {}

        if (result.text && result.text.trim()) {
          // Переводим на язык чата
          let translationResult = await translateText(result.text, result.lang || 'ru', settings.targetLang);
          let translation = translationResult.text;
          translation = translation.replace(/\.$/,'');
          await client.sendMessage(chatId, `🌐 ${translation}`);
          console.log(`[>>] Моё аудио (${result.lang}→${settings.targetLang}): ${translation.substring(0, 80)}`);
        }
      }
    }
    // Мой текст на русском → заменяем оригинал на перевод
    else if (msg.body && msg.body.trim()) {
      const sourceLang = detectLanguage(msg.body);
      if (sourceLang === MY_LANG) {
        let translationResult = await translateText(msg.body, 'ru', settings.targetLang);
        let translation = translationResult.text;
        translation = translation.replace(/\.$/,''); // убираем точку в конце
        // @c.us → edit оригинал, @lid → новое сообщение
        if (chatId.endsWith('@c.us')) {
          try {
            const editResult = await msg.edit(translation);
            if (editResult) {
              console.log(`[>>] EDIT (ru→${settings.targetLang}): ${translation.substring(0, 80)}`);
            } else {
              await client.sendMessage(chatId, `🌐 ${translation}`);
              console.log(`[>>] Мой текст (ru→${settings.targetLang}): ${translation.substring(0, 80)}`);
            }
          } catch (e) {
            await client.sendMessage(chatId, `🌐 ${translation}`);
            console.log(`[>>] Мой текст (ru→${settings.targetLang}): ${translation.substring(0, 80)}`);
          }
        } else {
          await client.sendMessage(chatId, `🌐 ${translation}`);
          console.log(`[>>] Мой текст (ru→${settings.targetLang}): ${translation.substring(0, 80)}`);
        }
      }
    }
  } catch (err) {
    console.error(`[!] Ошибка перевода исходящего: ${err.message}`);
  } finally {
    processingChats.delete(chatId + '_out');
  }
});

async function processMessage(msg, settings) {
  let text = msg.body || '';
  let detectedLang = '';

  // Аудио сообщение
  if (msg.hasMedia) {
    const media = await msg.downloadMedia();
    if (media && (msg.type === 'audio' || msg.type === 'ptt' || msg.type === 'video')) {
      // Сохраняем во временный файл
      const tmpFile = path.join(require('os').tmpdir(), `wa_audio_${Date.now()}.ogg`);
      fs.writeFileSync(tmpFile, Buffer.from(media.data, 'base64'));

      console.log(`[<<] Аудио от ${msg.from}, транскрибация...`);
      const result = await transcribeAudio(tmpFile);
      text = result.text;
      detectedLang = result.lang;

      // Удаляем временный файл
      try { fs.unlinkSync(tmpFile); } catch (e) {}

      if (!text || !text.trim()) {
        console.log('  [!] Пустая транскрипция, пропускаем');
        return;
      }

      console.log(`  [aai] Транскрипция: "${text.substring(0, 100)}..." (${detectedLang})`);
    } else {
      return; // Не аудио медиа — пропускаем
    }
  }

  if (!text || !text.trim()) return;

  // Определяем язык если ещё не определён
  if (!detectedLang) {
    detectedLang = detectLanguage(text);
  }

  // Нормализуем язык
  if (detectedLang === 'russian') detectedLang = 'ru';
  if (detectedLang === 'english') detectedLang = 'en';
  if (detectedLang === 'indonesian') detectedLang = 'id';

  // Входящее сообщение → переводим на русский (для меня)
  if (detectedLang !== MY_LANG && detectedLang !== 'unknown') {
    const translationResult = await translateText(text, detectedLang, MY_LANG);
    const translation = translationResult.text;
    detectedLang = translationResult.detectedLang || detectedLang;

    let replyText = '';
    if (msg.hasMedia) {
      // Для аудио: показываем транскрипцию + перевод
      replyText = `📝 [${detectedLang.toUpperCase()}]: ${text}\n\n🌐 [RU]: ${translation}`;
    } else {
      replyText = `🌐 [RU]: ${translation}`;
    }

    await msg.reply(replyText);
    console.log(`[<<] Перевод входящего (${detectedLang}→ru): ${translation.substring(0, 80)}`);

    // TTS озвучка перевода
    if (settings.tts) {
      try {
        const audioPath = await generateAudio(translation, MY_LANG);
        const audioMedia = MessageMedia.fromFilePath(audioPath);
        await client.sendMessage(msg.from, audioMedia, { sendAudioAsVoice: true });
        try { fs.unlinkSync(audioPath); } catch (e) {}
      } catch (ttsErr) {
        console.error(`  [tts] Ошибка озвучки: ${ttsErr.message}`);
      }
    }
  } else if (detectedLang === 'unknown') {
    // Язык не определён по эвристике — пусть GPT сам разберётся
    const translationResult = await translateText(text, 'auto', MY_LANG);
    const translation = translationResult.text;
    const actualLang = translationResult.detectedLang || 'auto';
    await msg.reply(`📝 [${actualLang.toUpperCase()}]: ${text}\n\n🌐 [RU]: ${translation}`);
    console.log(`[<<] Перевод (${actualLang}→ru): ${translation.substring(0, 80)}`);
  }
  // Если сообщение на русском от собеседника — не переводим (редкий кейс)
}

// === CATCHUP ПРОПУЩЕННЫХ ===
async function catchUpTranslations() {
  console.log('Проверяю пропущенные сообщения для перевода...\n');
  let found = 0;

  try {
    const chats = await client.getChats();

    for (const chat of chats) {
      if (chat.isGroup) continue;
      const chatId = chat.id._serialized;
      const settings = chatSettings[chatId];
      if (!settings || !settings.enabled) continue;

      if (!chat.lastMessage) continue;
      if (chat.lastMessage.fromMe) continue;
      if (!chat.lastMessage.body && !chat.lastMessage.hasMedia) continue;

      // Проверяем: сообщение непрочитано?
      if (chat.unreadCount > 0) {
        found++;
        console.log(`[!!] Непрочитано в ${chatId}: ${chat.unreadCount} сообщ.`);

        const lastMsg = chat.lastMessage;
        if (lastMsg.body || lastMsg.hasMedia) {
          try {
            await processMessage(lastMsg, settings);
          } catch (err) {
            console.error(`  [!] Ошибка catchup: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[!] Ошибка catchup: ${err.message}`);
  }

  if (found === 0) {
    console.log('Непереведённых сообщений нет.\n');
  } else {
    console.log(`Обработано ${found} чатов с непрочитанными.\n`);
  }
}

// === ТЕРМИНАЛ (только в интерактивном режиме) ===
let rl;
if (process.stdin.isTTY) {
  const readline = require('readline');
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function promptUser() {
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
      case 'catchup':
        await catchUpTranslations();
        break;
      case 'quit':
      case 'exit':
        console.log('Выход...');
        saveSettings();
        await client.destroy();
        process.exit(0);
        break;
      default:
        console.log('Команды: status, catchup, quit');
    }
    if (process.stdin.isTTY) { promptUser(); }
  });
}

// === ЗАПУСК ===
console.log('=== WhatsApp Translator ===');
console.log('AssemblyAI + GPT + TTS\n');

loadSettings();

process.on('unhandledRejection', (err) => {
  console.error('[!] Unhandled rejection:', err);
  // exit с failure чтобы systemd применил RestartSec (важно для snap chromium scope drain)
  setTimeout(() => process.exit(1), 100);
});

console.log('Подключение к WhatsApp...\n');
client.initialize();
