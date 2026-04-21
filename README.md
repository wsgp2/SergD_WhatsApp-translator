# SergD WhatsApp Translator

WhatsApp бот-переводчик: автоматический перевод текстовых и голосовых сообщений в WhatsApp чатах.

## Что делает

- **Входящие** сообщения (текст/аудио/видеокружочки) → переводятся на **русский**
- **Исходящие** сообщения на русском → переводятся на **язык чата** (по умолчанию English)
- Работает через `whatsapp-web.js` (эмуляция WhatsApp Web через headless Chromium)
- Использует AssemblyAI (primary) + OpenAI Whisper (fallback) для транскрипции аудио
- Использует GPT-5.4-mini для перевода с автоопределением языка
- Использует gpt-4o-mini-tts для озвучки переводов (опционально)

## Команды в чате

| Команда | Действие |
|---------|----------|
| `#translate` | Включить переводчик (по умолчанию → English) |
| `#translate en` | Включить + язык ответов English |
| `#translate id` | Включить + язык ответов Indonesian |
| `#translate th` | Включить + язык ответов Thai |
| `#stop` | Выключить переводчик |
| `#tts on` | Включить озвучку переводов |
| `#tts off` | Выключить озвучку |
| `#status` | Текущие настройки чата |

## Установка

### Требования
- Node.js >= 18
- Chromium (`apt install chromium-browser`)
- Аккаунт WhatsApp (для привязки как второе устройство)

### Шаги

```bash
# 1. Клон
git clone https://github.com/wsgp2/SergD_WhatsApp-translator.git
cd SergD_WhatsApp-translator

# 2. Зависимости
npm install

# 3. Настройка
cp .env.example .env
nano .env  # вписать OPENAI_API_KEY и ASSEMBLYAI_KEY

# 4. Первый запуск (нужен QR-код)
node translator.js
# Сканируем QR в WhatsApp → Настройки → Связанные устройства → Привязать
# Дожидаемся "WhatsApp Translator подключён!"
```

### Deploy как systemd сервис

```ini
# /etc/systemd/system/wa-translator.service
[Unit]
Description=WhatsApp Translator Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/bots/whatsapp_translator
ExecStart=/usr/bin/node translator.js
Restart=always
RestartSec=10
StandardOutput=append:/home/ubuntu/bots/whatsapp_translator/logs/wa-translator.log
StandardError=append:/home/ubuntu/bots/whatsapp_translator/logs/wa-translator.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable wa-translator
sudo systemctl start wa-translator
```

### Важные моменты

- **Сессия WhatsApp** хранится в `.wwebjs_auth/` — не коммитить, хранится локально
- **На ARM-серверах** (Oracle Cloud, Raspberry Pi) нужно явно указать `executablePath: '/usr/bin/chromium-browser'` в puppeteer config (уже сделано в коде)
- **Нельзя** запускать на двух машинах одновременно — WhatsApp отключит одну сессию

## Архитектура

```
Входящее сообщение в WhatsApp
    ↓
Команда? (#translate / #stop / #status) → handleCommand
    ↓ нет
Это мой чат с активным переводом?
    ↓ да
Аудио? → transcribeAudio() → AssemblyAI → текст + язык
       → fallback: Whisper-1 (OpenAI)
    ↓
translateText() → GPT-5.4-mini (JSON response с detected_language + translation)
    ↓
msg.reply("🌐 [RU]: перевод + emoji")
    ↓
TTS включён? → generateAudio() → gpt-4o-mini-tts → голосовое
```

## Логика языков

- Сообщение мне (от собеседника) → переводится на **русский**
- Моё сообщение на русском → переводится на **язык чата** (targetLang)
- Для `@c.us` чатов моё сообщение редактируется (edit)
- Для `@lid` чатов (бизнес) моё сообщение отправляется новым (edit не поддерживается)

## См. также

- Telegram-версия переводчика: работает на том же сервере в `/home/ubuntu/bots/telegram_voice_translator/`
- [DEPLOY.md](./DEPLOY.md) — детальная документация по развёртыванию
