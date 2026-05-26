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

/* ================= TELEGRAM & REDIS ================= */

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/* ================= URLS & PATHS ================= */

const TOMORROW_IMAGE_URL = "https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/images/kyiv-region/gpv-all-tomorrow.png";
const DATA_JSON_URL = "https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json";

// Шлях до твого шаблону з текстом:
const TEMPLATE_IMAGE_PATH = path.join(__dirname, "images", "empty_data_should_add_text.jpg");

/* ================= HELPERS ================= */

function getUkranianDateText(timestamp) {
  try {
    const date = new Date(timestamp * 1000);
    
    const months = [
      "січня", "лютого", "березня", "квітня", "травня", "червня",
      "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"
    ];

    const dayNum = date.getDate();
    const monthName = months[date.getMonth()];

    // На картинку піде чисто: "27 травня"
    return `${dayNum} ${monthName}`;
  } catch {
    return "на завтра";
  }
}

function formatDateFromTimestamp(timestamp) {
  try {
    const date = new Date(timestamp * 1000);
    const days = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
    return `${days[date.getDay()]}, ${String(date.getDate()).padStart(2,"0")}.${String(date.getMonth()+1).padStart(2,"0")}.${date.getFullYear()}`;
  } catch {
    return "Невідома дата";
  }
}

// Форматування системного часу з ISO (UTC) у красивий Київський формат "ДД.ММ.РРРР ГГ:ХХ"
function formatLastUpdated(isoString) {
  try {
    const date = new Date(isoString);
    const options = {
      timeZone: "Europe/Kyiv",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    return date.toLocaleString("uk-UA", options).replace(",", "");
  } catch {
    const now = new Date();
    return `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}.${now.getFullYear()} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  }
}

// Перевірка, чи є дата з рядка "ДД.ММ.РРРР ГГ:ХХ" сьогоднішнім днем (за Київським часом)
function isUpdateFromToday(updateStr) {
  if (!updateStr) return false;
  try {
    // Витягуємо "ДД.ММ.РРРР" з початку рядка
    const datePart = updateStr.split(" ")[0]; 
    
    // Отримуємо поточну дату в Києві у форматі ДД.ММ.РРРР
    const kyivToday = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    
    return datePart === kyivToday;
  } catch {
    return false;
  }
}

/* ================= ФУНКЦІЯ МАЛЮВАННЯ (ОКРЕМІ КОЛЬОРИ ТА КООРДИНАТИ) ================= */

async function generateEmptyDataImageWithText(dateText, fullUpdateTime) {
  // 1. Завантажуємо зображення-шаблон
  const image = await loadImage(TEMPLATE_IMAGE_PATH);

  // 2. Створюємо canvas точних розмірів шаблону
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");

  // 3. Малюємо фон (твій шаблон)
  ctx.drawImage(image, 0, 0, image.width, image.height);

  // 4. ЗАГАЛЬНІ НАЛАШТУВАННЯ ВИРІВНЮВАННЯ
  ctx.textAlign = "center"; 
  ctx.textBaseline = "middle";

  // ================= 📅 БЛОК 1: ДАТА (Наприклад: "27 травня") =================
  ctx.fillStyle = "#1b2423";                 // 🎨 Твій основний колір дати
  ctx.font = "bold 28px Arial, sans-serif";   // Шрифт дати
  
  const dateX = 444;                         // Твої координати по Х та Y
  const dateY = 52; 
  
  ctx.fillText(dateText, dateX, dateY);

  // ================= 🕒 БЛОК 2: ЧАС ТА ДАТА ОНОВЛЕННЯ (Наприклад: "04.05.2026 10:22") =================
  ctx.fillStyle = "#7a8a88";                 // 🎨 Твій приглушений сірий колір
  ctx.font = "bold 14px Arial, sans-serif";   // Твій розмір шрифту
  
  const timeX = 494;                         // Твоя координата X
  const timeY = 102;                         // Твоя координата Y
  
  ctx.fillText(fullUpdateTime, timeX, timeY);

  // 7. Повертаємо готовий Buffer
  return canvas.toBuffer("image/jpeg");
}

/* ================= MAIN ================= */

let isRunning = false;

async function checkSchedule() {
  if (isRunning) return;
  isRunning = true;

  try {
    console.log(`⏳ Перевірка GitHub (${new Date().toLocaleTimeString()})...`);

    const response = await axios.get(`${DATA_JSON_URL}?t=${Date.now()}`, { timeout: 10000 });
    const data = response.data;

    if (!data.meta || !data.meta.contentHash) {
      console.log("⚠️ contentHash відсутній");
      return;
    }

    const currentHash = data.meta.contentHash;
    console.log("📦 HASH:", currentHash);

    const savedHash = await redis.get("dtek_hash");
    if (savedHash && savedHash === currentHash) {
      console.log("✅ HASH вже був — нових даних немає");
      return;
    }

    /* ================= ПЕРЕВІРКА СТАНУ ДАНИХ ================= */
    const factData = data.fact?.data;
    const isEmptyData =
      !factData ||
      (Array.isArray(factData) && factData.length === 0) ||
      (typeof factData === "object" && !Array.isArray(factData) && Object.keys(factData).length === 0);

    const rawUpdate = data.fact?.update || "";
    const isToday = isUpdateFromToday(rawUpdate);

    console.log(`📊 Статус: isEmptyData=${isEmptyData}, rawUpdate="${rawUpdate}", єСьогоднішнім=${isToday}`);

    // Вираховуємо дату на завтра для опису поста
    const targetTimestamp = data.fact?.today ? (data.fact.today + 86400) : (Math.floor(Date.now() / 1000) + 86400);
    const logDateText = formatDateFromTimestamp(targetTimestamp);
    const systemUpdateTime = data.lastUpdated ? formatLastUpdated(data.lastUpdated) : formatLastUpdated(new Date().toISOString());

    /* ================= 🟢 КЕЙС 1: ДАНІ ПОРОЖНІ, АЛЕ UPDATE СВІЖИЙ (СЬОГОДНІШНІЙ) -> ОФІЦІЙНА КАРТИНКА ================= */
    if (isEmptyData && isToday) {
      console.log("🎯 Графіків немає, але ДТЕК оновив дані сьогодні! Беремо оригінальну картинку з GitHub...");

      const caption =
        `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
        `📆 ${logDateText}\n\n` +
        `✅ Наразі погодинні відключення не заплановані.\n\n` +
        `🕒 <i>Оновлено: ${rawUpdate}</i>\n\n` +
        `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a>`;

      const imageUrl = `${TOMORROW_IMAGE_URL}?t=${Date.now()}`;

      await bot.sendPhoto(CHAT_ID, imageUrl, {
        caption,
        parse_mode: "HTML",
      });

      console.log("✅ Офіційну свіжу картинку відправлено!");
      await redis.set("dtek_hash", currentHash);
      return;
    }

    /* ================= 🟡 КЕЙС 2: ДАНІ ПОРОЖНІ І UPDATE СТАРИЙ -> НАКЛАДАЄМО ТЕКСТ НА ШАБЛОН ================= */
    if (isEmptyData && !isToday) {
      console.log("⚠️ Графіків немає і ДТЕК спить (дата стара). Генеруємо локальний шаблон з актуальним часом...");

      const ukrDateText = getUkranianDateText(targetTimestamp); // "27 травня"

      // Малюємо: Блок 1 (Дата) та Блок 2 (Системний час перевірки)
      const processedImageBuffer = await generateEmptyDataImageWithText(ukrDateText, systemUpdateTime);

      const caption =
        `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
        `📆 ${logDateText}\n\n` +
        `✅ Наразі погодинні відключення не заплановані.\n\n` +
        `🕒 <i>Перевірено: ${systemUpdateTime}</i>\n\n` +
        `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a>`;

      await bot.sendPhoto(CHAT_ID, processedImageBuffer, {
        caption,
        parse_mode: "HTML",
      }, {
        filename: `empty_schedule_${Date.now()}.jpg`, 
        contentType: "image/jpeg"
      });

      console.log(`✅ Згенерований шаблон надіслано! Нанесено: "${ukrDateText}" та "${systemUpdateTime}"`);
      await redis.set("dtek_hash", currentHash);
      return;
    }

    /* ================= 🔴 КЕЙС 3: ГРАФІКИ Є (ЗВИЧАЙНА КАРТИНКА СХЕМИ) ================= */
    console.log("🔥 Знайдено активні графіки відключень! Надсилаємо схему...");
    
    const timestamps = Object.keys(factData).map(Number).filter((t) => !isNaN(t));
    let finalLogDate = logDateText;
    
    if (timestamps.length) {
      const newestTimestamp = Math.max(...timestamps);
      finalLogDate = formatDateFromTimestamp(newestTimestamp);
    }

    const caption =
      `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
      `📆 ${finalLogDate}\n\n` +
      `🕒 <i>Оновлено: ${rawUpdate || systemUpdateTime}</i>\n\n` +
      `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a>`;

    const imageUrl = `${TOMORROW_IMAGE_URL}?t=${Date.now()}`;

    await bot.sendPhoto(CHAT_ID, imageUrl, {
      caption,
      parse_mode: "HTML",
    });

    console.log("✅ Графік відключень відправлено в канал");
    await redis.set("dtek_hash", currentHash);

  } catch (err) {
    console.error("❌ Помилка в checkSchedule:", err.message);
  } finally {
    isRunning = false;
  }
}

/* ================= LOOP ================= */

// Запуск кожну хвилину (60000 мс) для стабільності вашого IP перед GitHub API
setInterval(checkSchedule, 60000); 
checkSchedule();

/* ================= SERVER ================= */

const app = express();
app.get("/", (req, res) => res.send("Bot is running 🚀"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));