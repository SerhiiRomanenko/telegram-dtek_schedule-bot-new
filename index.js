require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");
const { Redis } = require("@upstash/redis");

/* ================= ENV ================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID in .env");
  process.exit(1);
}

/* ================= TELEGRAM & REDIS ================= */

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/* ================= URLS & PATHS ================= */

const TOMORROW_IMAGE_URL = "https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/images/kyiv-region/gpv-all-tomorrow.png";
const DATA_JSON_URL = "https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json";
const TEMPLATE_IMAGE_PATH = path.join(__dirname, "images", "empty_data_should_add_text.jpg");

/* ================= CONSTANTS ================= */

const POLL_INTERVAL_MS = 30_000;
const KYIV = "Europe/Kyiv";

/* ================= HELPERS ================= */

function extractKyivDay(unixTs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KYIV,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(unixTs * 1000));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDayCaption(unixTs) {
  const date = new Date(unixTs * 1000);
  const day = String(date.getDate()).padStart(2, "0");
  const mon = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const days = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
  const weekday = days[date.getDay()];
  return `${weekday}, ${day}.${mon}.${year}`;
}

function formatUpdate(raw) {
  if (raw && /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(raw)) return raw;
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const mon = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${day}.${mon}.${year} ${hh}:${mm}`;
}

function getKyivTimeShort() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/* ================= CANVAS ================= */

async function generateTemplateImage(dateText, timeText) {
  const image = await loadImage(TEMPLATE_IMAGE_PATH);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(image, 0, 0, image.width, image.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#1b2423";
  ctx.font = "bold 28px Arial, sans-serif";
  ctx.fillText(dateText, 444, 52);

  ctx.fillStyle = "#7a8a88";
  ctx.font = "bold 14px Arial, sans-serif";
  ctx.fillText(timeText, 494, 102);

  return canvas.toBuffer("image/jpeg");
}

/* ================= CAPTIONS ================= */

function buildCaptionWithData(dayText, updateText, region) {
  return (
    `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
    `📅 ${dayText}\n\n` +
    `🔄 <i>Оновлено: ${updateText}</i>\n\n` +
    `` +
    `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a> | <a href="https://t.me/xy_dmin">Прислати новину</a>`
  );
}

function buildCaptionNoData(dayText, region) {
  return (
    `⚡️💡 <b>Київщина: відключення світла</b>\n` +
    `📅 ${dayText}\n\n` +
    `✅ Графіків немає — очікуйте оновлення від ДТЕК\n\n` +
    `` +
    `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a> | <a href="https://t.me/xy_dmin">Прислати новину</a>`
  );
}

/* ================= TELEGRAM ACTIONS ================= */

async function sendPhoto(image, caption, isBuffer) {
  if (isBuffer) {
    return bot.sendPhoto(CHAT_ID, image, {
      caption,
      parse_mode: "HTML",
    }, {
      filename: `schedule_${Date.now()}.jpg`,
      contentType: "image/jpeg",
    });
  }
  return bot.sendPhoto(CHAT_ID, image, {
    caption,
    parse_mode: "HTML",
  });
}

async function editPost(msgId, caption, image, isBuffer) {
  try {
    await bot.editMessageCaption(msgId, caption, {
      chat_id: CHAT_ID,
      parse_mode: "HTML",
    });

    const media = isBuffer
      ? image
      : { type: "photo", media: image };

    await bot.editMessageMedia(msgId, media, { chat_id: CHAT_ID });
    return true;
  } catch (err) {
    if (err.code === "EFATAL" || err.response?.statusCode === 403) {
      return false;
    }
    throw err;
  }
}

/* ================= MAIN LOOP ================= */

let isRunning = false;

async function checkSchedule() {
  if (isRunning) return;
  isRunning = true;

  try {
    const response = await axios.get(`${DATA_JSON_URL}?t=${Date.now()}`, { timeout: 15000 });
    const data = response.data;

    if (!data.meta?.contentHash) {
      console.log("⚠️ contentHash відсутній");
      return;
    }

    const currentHash = data.meta.contentHash;

    const savedHash = await redis.get("dtek:hash");
    if (savedHash === currentHash) {
      return;
    }

    const factToday = data.fact?.today ?? Math.floor(Date.now() / 1000);
    const currentDay = extractKyivDay(factToday);

    const savedDay = await redis.get("dtek:day");
    const savedMsgId = await redis.get("dtek:msgId");

    const factData = data.fact?.data;
    const isEmptyData = !factData || Object.keys(factData).length === 0;

    const updateText = formatUpdate(data.fact?.update);
    const region = data.regionAffiliation || "Київська обл.";
    const dayText = formatDayCaption(factToday);

    const caption = isEmptyData
      ? buildCaptionNoData(dayText, region)
      : buildCaptionWithData(dayText, updateText, region);

    let image, isBuffer = false;
    if (isEmptyData) {
      const dateText = dayText.split(", ").pop();
      image = await generateTemplateImage(dateText, updateText);
      isBuffer = true;
    } else {
      image = `${TOMORROW_IMAGE_URL}?t=${Date.now()}`;
    }

    const isNewDay = savedDay !== currentDay || !savedMsgId;

    if (isNewDay) {
      const msg = await sendPhoto(image, caption, isBuffer);
      await Promise.all([
        redis.set("dtek:msgId", String(msg.message_id)),
        redis.set("dtek:day", currentDay),
      ]);
    } else {
      const ok = await editPost(savedMsgId, caption, image, isBuffer);
      if (!ok) {
        await bot.sendMessage(CHAT_ID, `🔄 Графік оновлено станом на ${getKyivTimeShort()}. Актуальна версія нижче.`);
        const msg = await sendPhoto(image, caption, isBuffer);
        await redis.set("dtek:msgId", String(msg.message_id));
      }
    }

    await redis.set("dtek:hash", currentHash);
  } catch (err) {
    console.error("❌ Помилка:", err.message);
  } finally {
    isRunning = false;
  }
}

/* ================= STARTUP ================= */

const pollInterval = setInterval(checkSchedule, POLL_INTERVAL_MS);
checkSchedule();

function shutdown() {
  console.log("🛑 Shutting down...");
  clearInterval(pollInterval);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ==== Express (для Render)
const app = express();
app.get("/", (req, res) => {
    res.send("Бот працює 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущено на порту ${PORT}`));