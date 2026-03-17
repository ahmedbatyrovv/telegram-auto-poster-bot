const TelegramBot = require("node-telegram-bot-api");
const schedule = require("node-schedule");
const fs = require("fs-extra");
const path = require("path");

const TOKEN = "8599177717:AAG0zSi32RrQz_bW0aNb5WFlru1ESVu9dOE";
const SUPER_ADMIN_IDS = [6179312865];

let ADMIN_IDS = [...SUPER_ADMIN_IDS];

const DATA_FILE = path.join(__dirname, "bot_data.json");

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 3000,
    params: { timeout: 15 },
    retryOnNetworkErrors: true,
  },
});

let botData = {
  users: {},
  hasStarted: false,
  additionalAdmins: [],
};

const activeJobs = new Map();
const processingLocks = new Map();

function log(msg, level = "INFO") {
  const time = new Date().toISOString();
  console.log(`[${time}] [${level}] ${msg}`);
}

async function loadData() {
  try {
    if (await fs.pathExists(DATA_FILE)) {
      const loaded = await fs.readJson(DATA_FILE);
      botData = { ...botData, ...loaded };
      ADMIN_IDS = [...SUPER_ADMIN_IDS, ...botData.additionalAdmins];
      log(`Maglumatlar ýüklenildi. Admin sany: ${ADMIN_IDS.length}`);
    }
  } catch (err) {
    log(`Maglumat ýüklemek ýalňyşlygy: ${err.message}`, "ERROR");
  }

  Object.keys(botData.users).forEach((uid) => {
    const user = botData.users[uid];
    user.channels.forEach((ch) => scheduleChannel(uid, ch.channel));
  });
}

async function saveData() {
  try {
    await fs.writeJson(
      DATA_FILE,
      {
        users: botData.users,
        hasStarted: botData.hasStarted,
        additionalAdmins: botData.additionalAdmins,
      },
      { spaces: 2 },
    );
    log("Maglumatlar saklandy");
  } catch (err) {
    log(`Maglumat saklamak ýalňyşlygy: ${err.message}`, "ERROR");
  }
}

loadData().then(() => log("Bot işledi!", "START"));

function isAdmin(uid) {
  return ADMIN_IDS.includes(uid);
}
function isSuperAdmin(uid) {
  return SUPER_ADMIN_IDS.includes(uid);
}

function getUser(uid) {
  if (!botData.users[uid]) {
    botData.users[uid] = {
      channels: [],
      message: "Salam! Bu awtomat post 🚀",
      interval: isSuperAdmin(uid) ? 60 : 300,
      tariff: isSuperAdmin(uid) ? "Premium" : "Standart",
      sentCount: 0,
      states: {},
    };
    log(`Täze user döredildi: ${uid} (${botData.users[uid].tariff})`);
  }
  return botData.users[uid];
}

function channelExistsForUser(uid, channel) {
  const u = getUser(uid);
  return u.channels.some(
    (c) => c.channel.toLowerCase() === channel.toLowerCase(),
  );
}

/* ──────────────────────────────────────────────── */
/*                  /start                         */
/* ──────────────────────────────────────────────── */

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  log(`User /start basdy: ${uid} (${msg.from.username || "adsyz"})`);

  if (!isAdmin(uid)) {
    bot.sendMessage(chatId, "Bu bot diňe admin üçin! 🚫");
    return;
  }

  const u = getUser(uid);
  const tariff = u.tariff;

  let txt = `Salam! Auto-Posting BOT'una hoş geldiňiz! Bu BOT arkaly öz Telegram kanallaryňyza awtomatik habar ugradyp bilersiňiz\n\n`;

  if (!botData.hasStarted) {
    txt += ``;
    botData.hasStarted = true;
    saveData();
  }

  txt += `Aşakdaky buýruklary ýerine ýetiriň we ulanyň:

1. 📢 Öz kanalyňy goş
2. 📝 Öz habaryňy ýaz
3. ⏰ Öz wagtyňy goý
4. 🗑️ Kanal aýyr
5. 📊 Statistika
6. 👤 User Info`;

  const kb = {
    keyboard: [
      ["📝 Habar ýazmak", "⏰ Wagt goýmak"],
      ["📢 Kanal goşmak", "🗑️ Kanal aýyrmak"],
      ["👤 User Info"],
    ],
    resize_keyboard: true,
  };

  bot
    .sendMessage(chatId, txt, { reply_markup: kb })
    .catch((err) => log(`/start habar ýalňyşlygy: ${err.message}`, "ERROR"));
});

/* ──────────────────────────────────────────────── */
/*                  /admin                         */
/* ──────────────────────────────────────────────── */

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  log(`User /admin ulandy: ${uid}`);

  if (!isSuperAdmin(uid))
    return bot.sendMessage(chatId, "Bu komanda diňe admin üçin!");

  const kb = {
    inline_keyboard: [
      [{ text: "👤 Add User", callback_data: "add_admin" }],
      [{ text: "🗑️ Delete User ", callback_data: "del_admin" }],
    ],
  };

  bot
    .sendMessage(chatId, "Admin paneli", { reply_markup: kb })
    .catch((err) => log(`/admin ýalňyşlygy: ${err.message}`, "ERROR"));
});

/* ──────────────────────────────────────────────── */
/*                  Callback                       */
/* ──────────────────────────────────────────────── */

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const uid = q.from.id;
  const data = q.data;

  log(`Callback: ${data} tarapyndan ${uid}`);

  if (!isAdmin(uid)) return;

  try {
    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    log(`Callback jogaby ýalňyşlygy: ${err.message}`, "ERROR");
  }

  const u = getUser(uid);

  if (data.startsWith("del_channel_")) {
    const ch = data.replace("del_channel_", "");
    const idx = u.channels.findIndex((c) => c.channel === ch);
    if (idx > -1) {
      const jobKey = `${uid}-${ch}`;
      if (activeJobs.has(jobKey)) {
        activeJobs.get(jobKey).cancel();
        activeJobs.delete(jobKey);
      }
      u.channels.splice(idx, 1);
      await saveData().catch(() => {});
      bot.sendMessage(chatId, `Kanal aýyryldy: ${ch}`).catch(() => {});
      log(`Kanal aýyryldy: ${ch} (user ${uid})`);
    }
    return;
  }

  if (!isSuperAdmin(uid)) return;

  if (data === "add_admin") {
    u.states.add_admin = true;
    await saveData().catch(() => {});
    bot.sendMessage(chatId, "Täze admin ID-sini ýaz:");
    return;
  }

  if (data === "del_admin") {
    if (!botData.additionalAdmins.length)
      return bot.sendMessage(chatId, "Goşulan admin ýok");
    const kb = {
      inline_keyboard: botData.additionalAdmins.map((id) => [
        { text: `ID: ${id}`, callback_data: `del_admin_${id}` },
      ]),
    };
    bot.sendMessage(chatId, "Aýyrmak isleýän admini saýla:", {
      reply_markup: kb,
    });
  }

  if (data.startsWith("del_admin_")) {
    const id = Number(data.replace("del_admin_", ""));
    const idx = botData.additionalAdmins.indexOf(id);
    if (idx > -1 && !SUPER_ADMIN_IDS.includes(id)) {
      botData.additionalAdmins.splice(idx, 1);
      ADMIN_IDS = [...SUPER_ADMIN_IDS, ...botData.additionalAdmins];
      await saveData().catch(() => {});
      bot.sendMessage(chatId, `Admin aýyryldy: ${id}`);
      log(`Admin aýyryldy: ${id} (user ${uid})`);
    }
  }
});

/* ──────────────────────────────────────────────── */
/*                  Knopka / habar                 */
/* ──────────────────────────────────────────────── */

bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const txt = msg.text?.trim();

  if (!isAdmin(uid)) return;

  log(`User habar ýazdy: ${uid} → "${txt}"`);

  const u = getUser(uid);

  // state
  if (u.states && Object.keys(u.states).length) {
    const key = Object.keys(u.states)[0];

    try {
      if (key === "add_admin") {
        const newId = Number(txt);
        if (isNaN(newId)) throw new Error("Ýalňyş ID");
        if (ADMIN_IDS.includes(newId)) throw new Error("Bu ID eýýäm admin");
        botData.additionalAdmins.push(newId);
        ADMIN_IDS.push(newId);
        delete u.states.add_admin;
        await saveData();
        bot.sendMessage(chatId, `Täze admin goşuldy: ${newId}`);
        log(`Täze admin goşuldy: ${newId}`);
        return;
      }

      if (key === "message") {
        u.message = txt;
        delete u.states.message;
        await saveData();
        bot.sendMessage(chatId, `Habaryň saklandy:\n${txt}`);
        log(`Habar üýtgedildi: ${uid}`);
        return;
      }

      if (key === "interval") {
        const sec = Number(txt);
        const min = u.tariff === "Premium" ? 10 : 300;
        if (isNaN(sec) || sec < min)
          throw new Error(`Iň az ${min} sek bolmaly`);
        u.interval = sec;
        u.channels.forEach((ch) => scheduleChannel(uid, ch.channel));
        delete u.states.interval;
        await saveData();
        bot.sendMessage(chatId, `Wagtyň üýtgedildi: ${sec} sek`);
        log(`Wagt üýtgedildi: ${uid} → ${sec} sek`);
        return;
      }

      if (key === "channel") {
        if (!txt.startsWith("@")) throw new Error("Kanal @ bilen başlamaly");
        if (channelExistsForUser(uid, txt))
          throw new Error("Bu kanal eýýäm bar");

        u.channels.push({ channel: txt, lastMsgId: null });
        scheduleChannel(uid, txt);
        delete u.states.channel;
        await saveData();
        bot.sendMessage(chatId, `Kanal goşuldy: ${txt}`);
        log(`Kanal goşuldy: ${uid} → ${txt}`);
        return;
      }
    } catch (err) {
      log(`State ýalňyşlygy: ${err.message} (user ${uid})`, "ERROR");
      bot.sendMessage(chatId, `Ýalňyşlyk: ${err.message}`);
    }
  }

  // knopkalar
  try {
    if (txt === "📝 Habar ýazmak") {
      u.states.message = true;
      await saveData();
      bot.sendMessage(chatId, "Kanallara iberiljek habaryňy ýaz:");
      log(`Habar ýazmak başlady: ${uid}`);
    } else if (txt === "⏰ Wagt goýmak") {
      u.states.interval = true;
      await saveData();
      const min = u.tariff === "Premium" ? 10 : 300;
      bot.sendMessage(
        chatId,
        `Her näçe sekuntda post atsın? (iň az ${min} sek)`,
      );
      log(`Wagt goýmak başlady: ${uid}`);
    } else if (txt === "📢 Kanal goşmak") {
      if (u.tariff === "Standart" && u.channels.length >= 1) {
        bot.sendMessage(
          chatId,
          "Standart tarifde diňe 1 kanal goşup bilersiň.\nPremium üçin super admin bilen habarlaş.",
        );
        log(`Standart user 2-nji kanal synanyşdy: ${uid}`);
      } else {
        u.states.channel = true;
        await saveData();
        bot.sendMessage(chatId, "Kanaldyň @username-ni ýaz:");
        log(`Kanal goşmak başlady: ${uid}`);
      }
    } else if (txt === "🗑️ Kanal aýyrmak") {
      if (!u.channels.length) return bot.sendMessage(chatId, "Hiç kanal ýok");
      const kb = {
        inline_keyboard: u.channels.map((c) => [
          { text: c.channel, callback_data: `del_channel_${c.channel}` },
        ]),
      };
      bot.sendMessage(chatId, "Aýyrmak isleýän kanaly saýla:", {
        reply_markup: kb,
      });
      log(`Kanal aýyrmak açdy: ${uid}`);
    } else if (txt === "👤 User Info") {
      const chans = u.channels.map((c) => c.channel).join("\n") || "ýok";
      bot.sendMessage(
        chatId,
        `👤 User Info

🆔 ID: ${uid}
💳 Tariff: ${u.tariff}
🗂️ Kanal sany:\n${chans}
💬 Habar: ${u.message}
🕒 Ugradylýan Wagt: ${u.interval} sek
📨 Ugradylan post: ${u.sentCount || 0}`,
      );
      log(`Öz maglumatlaryny gördi: ${uid}`);
    }
  } catch (err) {
    log(`Knopka ýalňyşlygy: ${err.message} (user ${uid})`, "ERROR");
    bot.sendMessage(chatId, "Bir zat ýalňyş boldy. Soňrak synap görüň.");
  }
});

/* ──────────────────────────────────────────────── */
/*                  Awtomat post                   */
/* ──────────────────────────────────────────────── */

function scheduleChannel(userId, channel) {
  const u = getUser(userId);
  const jobKey = `${userId}-${channel}`;

  if (activeJobs.has(jobKey)) {
    activeJobs.get(jobKey).cancel();
    activeJobs.delete(jobKey);
  }

  log(`Schedule başlady: ${userId} → ${channel} (her ${u.interval} sek)`);

  const job = schedule.scheduleJob(`*/${u.interval} * * * * *`, async () => {
    if (processingLocks.get(jobKey)) {
      log(`Overlap gaçyş: ${jobKey}`, "WARNING");
      return;
    }
    processingLocks.set(jobKey, true);

    try {
      const chData = u.channels.find((c) => c.channel === channel);
      if (chData?.lastMsgId) {
        try {
          await bot.deleteMessage(channel, chData.lastMsgId);
          log(`Öňki post pozuldy: ${channel} → ${chData.lastMsgId}`);
        } catch (e) {
          log(`Pozmak ýalňyşlygy: ${e.message}`, "WARNING");
        }
      }

      const sent = await bot.sendMessage(channel, u.message, {
        parse_mode: "HTML",
        disable_notification: true,
      });

      if (chData) chData.lastMsgId = sent.message_id;

      u.sentCount = (u.sentCount || 0) + 1;
      await saveData();

      log(
        `Post iberildi: ${userId} → ${channel} (ID: ${sent.message_id}) | Jemi: ${u.sentCount}`,
      );
    } catch (err) {
      log(`Post ýalňyşlygy: ${err.message} (${userId} → ${channel})`, "ERROR");
    } finally {
      processingLocks.set(jobKey, false);
    }
  });

  activeJobs.set(jobKey, job);
}
