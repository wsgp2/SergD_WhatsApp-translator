# WhatsApp Translator Bot — Документация для деплоя

## Что это

WhatsApp бот-переводчик, который автоматически переводит текстовые и голосовые сообщения в WhatsApp чатах. Работает через whatsapp-web.js (эмуляция WhatsApp Web через Puppeteer/Chromium).

**Владелец:** Сергей Дышкант (@sergei_dyshkant)

---

## Как работает

1. Бот подключается к WhatsApp через QR-код (как второе устройство)
2. В любом чате отправляешь `#translate` — переводчик включается для этого чата
3. **Входящие** сообщения (текст/аудио/видеокружочки) переводятся на **русский**
4. **Исходящие** сообщения на русском переводятся на **язык чата** (по умолчанию английский)
5. Для `@c.us` чатов — исходящее сообщение редактируется на перевод (edit). Для `@lid` чатов — перевод отправляется новым сообщением
6. При перезапуске бот проверяет непрочитанные сообщения в активных чатах и переводит их (catchup)

### Команды в чате

| Команда | Действие |
|---------|----------|
| `#translate` | Включить переводчик (по умолчанию → English) |
| `#translate th` | Включить + язык ответов Thai |
| `#translate id` | Включить + язык ответов Indonesian |
| `#stop` | Выключить переводчик |
| `#tts on` | Включить озвучку переводов |
| `#tts off` | Выключить озвучку |
| `#status` | Текущие настройки чата |

---

## Структура проекта

```
SergD_Finder_Agent/
├── translator.js              # Основной файл бота-переводчика
├── translator_settings.json   # Настройки per-chat (автогенерация)
├── package.json               # npm зависимости
├── .wwebjs_auth/              # Сессия WhatsApp (создаётся при первом QR-скане)
│
├── bot.js                     # Бот поиска аренды мотоциклов (отдельный проект)
├── contacts.json              # Контакты прокатов мото
├── conversations.json         # История переписок с прокатами
├── chatmap.json               # Маппинг WhatsApp бизнес-ID → номера
│
├── translator_source/         # Исходники Telegram-версии переводчика (справочно)
│   ├── translator_bot_server.py
│   ├── .env
│   └── utils/
│
├── samui_bike_rental_contacts.md  # Собранные контакты прокатов
├── message_template.md            # Шаблон сообщения для прокатов
└── DEPLOY.md                      # Этот файл
```

### Какой файл запускать

- **`translator.js`** — бот-переводчик (основной)
- **`bot.js`** — бот поиска аренды мотоциклов (отдельная задача)
- **Нельзя запускать оба одновременно** — они используют одну WhatsApp сессию

---

## API ключи (уже вшиты в translator.js)

| Сервис | Для чего | Ключ |
|--------|----------|------|
| **OpenAI** | Перевод (GPT-4o-mini), TTS озвучка, Whisper fallback | `<OPENAI_API_KEY in .env>` (строка 9 в translator.js) |
| **AssemblyAI** | Транскрипция аудио (primary) | `<ASSEMBLYAI_KEY in .env>` (строка 10) |

> При деплое можно вынести в `.env`, но сейчас они хардкоднуты в файле для простоты.

---

## Пайплайн обработки сообщений

### Входящее (мне пишут):
```
Текст/Аудио/Кружочек от собеседника
    ↓
Аудио? → transcribeAudio() → AssemblyAI (REST API) → текст + язык
    ↓                          ↓ fallback
    ↓                        Whisper-1 (OpenAI)
    ↓
detectLanguage() — определение языка (если не из транскрипции)
    ↓
translateText() — GPT-4o-mini → перевод на русский
    ↓
msg.reply("🌐 [RU]: перевод")  — ответ в чат
    ↓
TTS включён? → generateAudio() → gpt-4o-mini-tts → голосовое в чат
```

### Исходящее (я пишу):
```
Мой текст на русском / моё аудио
    ↓
Аудио? → transcribeAudio() → текст
    ↓
detectLanguage() — русский?
    ↓ да
translateText() → GPT-4o-mini → перевод на язык чата
    ↓
@c.us чат? → msg.edit(перевод)     ← заменяет оригинал
@lid чат?  → sendMessage("🌐 перевод")  ← новое сообщение
```

---

## Ключевые функции (translator.js)

| Функция | Что делает |
|---------|-----------|
| `transcribeAudio(filePath)` | Аудио → текст. AssemblyAI primary (REST API, speech_models: universal-3-pro + universal-2), Whisper-1 fallback |
| `translateText(text, srcLang, tgtLang)` | Текст → перевод через GPT-4o-mini |
| `generateAudio(text, lang)` | Текст → аудио через gpt-4o-mini-tts (голос: onyx) |
| `detectLanguage(text)` | Быстрое определение языка по символам (кириллица → ru) |
| `processMessage(msg, settings)` | Оркестратор входящих: аудио/текст → транскрипция → перевод → ответ |
| `handleCommand(msg)` | Обработка #translate, #stop, #tts, #status |
| `catchUpTranslations()` | При старте: проверяет непрочитанные в активных чатах |
| `isDuplicate(chatId, text)` | Дебаунс: не переводит одинаковый текст за 30 сек |
| `getChatSettingsForId(chatId)` | Поиск настроек с поддержкой @c.us и @lid форматов |

---

## Настройки per-chat (translator_settings.json)

Автоматически создаётся при `#translate`. Формат:

```json
{
  "628111500998@c.us": {
    "enabled": true,
    "targetLang": "en",
    "tts": false
  }
}
```

- `enabled` — переводчик включён/выключен
- `targetLang` — на какой язык переводить мои сообщения (en, th, id, и т.д.)
- `tts` — озвучивать ли переводы

---

## Деплой на сервер

### Требования

- **Node.js** >= 18
- **Chromium** (для puppeteer/whatsapp-web.js)
- ~500 MB RAM (Chromium в headless)

### Шаги

```bash
# 1. Клонируем / копируем проект
scp -r /Users/wsgp/SergD_Finder_Agent/ user@server:/home/user/whatsapp-translator/

# 2. На сервере
cd /home/user/whatsapp-translator
npm install

# 3. Устанавливаем Chromium (если нет)
# Ubuntu/Debian:
sudo apt-get install -y chromium-browser
# Или через puppeteer:
npx puppeteer browsers install chrome

# 4. Первый запуск (нужен QR-код)
node translator.js
# Сканируем QR в WhatsApp → Настройки → Связанные устройства → Привязать
# Дожидаемся "WhatsApp Translator подключён!"
# Ctrl+C

# 5. Запуск как сервис (systemd)
sudo nano /etc/systemd/system/wa-translator.service
```

### Systemd сервис

```ini
[Unit]
Description=WhatsApp Translator Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/user/whatsapp-translator
ExecStart=/usr/bin/node translator.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable wa-translator
sudo systemctl start wa-translator

# Логи
journalctl -u wa-translator -f
```

### Важно

- **Сессия WhatsApp** хранится в `.wwebjs_auth/` (~100MB). Можно перенести эту папку с рабочей машины на сервер — тогда QR сканировать не нужно. Просто скопировать вместе с проектом:
  ```bash
  scp -r .wwebjs_auth/ user@server:/home/user/whatsapp-translator/
  ```
- **Нельзя** запускать на двух машинах одновременно — WhatsApp отключит одну из сессий
- **Chromium на сервере** может требовать дополнительные библиотеки:
  ```bash
  sudo apt-get install -y libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxrandr2 libgbm-dev libasound2
  ```

---

## Особенности и ограничения

1. **Edit сообщений** работает только в `@c.us` чатах. В `@lid` (бизнес-аккаунты) — edit не поддерживается WhatsApp API, перевод отправляется новым сообщением
2. **Дебаунс 30 сек** — одинаковый текст от одного контакта не переводится повторно (защита от автоответчиков)
3. **Точка в конце** — автоматически убирается из исходящих переводов
4. **Catchup** при старте — проверяет только `lastMessage` каждого чата (не подгружает историю, т.к. `fetchMessages` не работает стабильно в headless)
5. **AssemblyAI SDK** (npm пакет) имеет баг с `speech_models` — поэтому используется прямой REST API вызов
6. **15 секунд дебаунс** для bike-бота (bot.js), 30 сек дедупликация для переводчика

---

## Терминальные команды бота

| Команда | Что делает |
|---------|-----------|
| `status` | Показать все чаты с активным переводом |
| `catchup` | Вручную проверить непрочитанные |
| `quit` | Сохранить и выйти |

---

## Связь с Telegram-версией

Существует Telegram-версия этого же переводчика — использует ту же логику перевода (AssemblyAI + GPT-5.4-mini + gpt-4o-mini-tts), но другую транспортную обёртку: `python-telegram-bot` вместо `whatsapp-web.js`.
