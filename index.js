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

    return `${dayNum} ${monthName}`;
  } catch {
    return "на зазначений день";
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

// Перевірка, чи є дата з рядка ДД.ММ.РРРР ГГ:ХХ сьогоднішнім днем 
function isUpdateFromToday(updateStr) {
  if (!updateStr) return false;
  try {
    const datePart = updateStr.split(" ")[0]; 
    
    // Отримуємо поточну дату в Києві у форматі ДД.ММ.РРРР
    const kyivToday = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    
    return datePart === kyivToday;
  } catch {
    return false;
  }
}

// Функція для визначення поточної години в часовому поясі Києва
function getKyivHour() {
  const options = { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false };
  const formatter = new Intl.DateTimeFormat("en-US", options);
  return parseInt(formatter.format(new Date()), 10);
}

/* ================= ФУНКЦІЯ МАЛЮВАННЯ (ОКРЕМІ КОЛЬОРИ ТА КООРДИНАТИ) ================= */

async function generateEmptyDataImageWithText(dateText, fullUpdateTime) {
  // 1. Завантажуємо зображення-шаблон
  const image = await loadImage(TEMPLATE_IMAGE_PATH);

  // 2. Створюємо canvas точних розмірів шаблону
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");

  // 3. Малюємо фон 
  ctx.drawImage(image, 0, 0, image.width, image.height);

  // 4. ЗАГАЛЬНІ НАЛАШТУВАННЯ ВИРІВНЮВАННЯ
  ctx.textAlign = "center"; 
  ctx.textBaseline = "middle";

  // ================= 📅 БЛОК 1: ДАТА =================
  ctx.fillStyle = "#1b2423";                 
  ctx.font = "bold 28px Arial, sans-serif";   
  
  const dateX = 444;                        
  const dateY = 52; 
  
  ctx.fillText(dateText, dateX, dateY);

  // ================= 🕒 БЛОК 2: ЧАС ТА ДАТА ОНОВЛЕННЯ =================
  ctx.fillStyle = "#7a8a88";                 
  ctx.font = "bold 14px Arial, sans-serif";   
  
  const timeX = 494;                        
  const timeY = 102;                        
  
  ctx.fillText(fullUpdateTime, timeX, timeY);

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

    /* ================= ДИНАМІЧНЕ ВИЗНАЧЕННЯ ЦІЛЬОВОЇ ДАТИ ================= */
    const currentKyivHour = getKyivHour();
    let targetTimestamp;

    if (data.fact?.today) {
      // Якщо в JSON є мітка дня, відштовхуємось від неї
      if (currentKyivHour < 10) {
        targetTimestamp = data.fact.today; // До 10:00 — це сьогоднішній день з JSON
        console.log(`⏰ Час < 10:00 (${currentKyivHour}:00). Беремо графік на СЬОГОДНІ.`);
      } else {
        targetTimestamp = data.fact.today + 86400; // Після 10:00 — це наступний день
        console.log(`⏰ Час >= 10:00 (${currentKyivHour}:00). Беремо графік на ЗАВТРА.`);
      }
    } else {
      // Якщо мітки немає, беремо поточний системний час
      const nowTimestamp = Math.floor(Date.now() / 1000);
      if (currentKyivHour < 10) {
        targetTimestamp = nowTimestamp;
        console.log(`⏰ Час < 10:00 (${currentKyivHour}:00). Орієнтир: поточна дата.`);
      } else {
        targetTimestamp = nowTimestamp + 86400;
        console.log(`⏰ Час >= 10:00 (${currentKyivHour}:00). Орієнтир: завтрашня дата.`);
      }
    }

    const logDateText = formatDateFromTimestamp(targetTimestamp);
    const systemUpdateTime = data.lastUpdated ? formatLastUpdated(data.lastUpdated) : formatLastUpdated(new Date().toISOString());

    /* ================= 🟢 КЕЙС 1: ДАНІ ПОРОЖНІ, АЛЕ UPDATE СЬОГОДНІШНІЙ -> ОФІЦІЙНА КАРТИНКА ================= */
    if (isEmptyData && isToday) {
      console.log("🎯 Графіків немає, але ДТЕК оновив дані сьогодні! Беремо оригінальну картинку з GitHub...");

      const caption =
        `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
        `📆 ${logDateText}\n\n` +
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

      const ukrDateText = getUkranianDateText(targetTimestamp); 

      // Малюємо дату та системний час перевірки
      const processedImageBuffer = await generateEmptyDataImageWithText(ukrDateText, systemUpdateTime);

      const caption =
        `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
        `📆 ${logDateText}\n\n` +
        `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a> | <a href="https://t.me/xy_dmin">Прислати новину</a>`;

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
    
    // Замість безумовного пошуку максимального таймстампу з масиву (який міг збити дату),
    // використовуємо нашу вираховану логічну дату finalLogDate.
    const caption =
      `⚡️💡 <b>Київщина: графік відключення світла</b>\n` +
      `📆 ${logDateText}\n\n` +
      `🕒 <i>Оновлено: ${rawUpdate || systemUpdateTime}</i>\n\n` +
      `<a href="https://t.me/huyova_bila_tserkva">✅ Хуйова Біла Церква</a> | <a href="https://t.me/xy_dmin">Прислати новину</a>`;

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

// Запуск кожну хвилину для стабільності роботи перед GitHub API
setInterval(checkSchedule, 60000); 
checkSchedule();

/* ================= SERVER ================= */
const app = express();
app.get("/", (req, res) => res.send("Bot is running 🚀"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));