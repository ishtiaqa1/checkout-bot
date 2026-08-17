import { parseStockAlert } from "./externalAlerts.js";
import { log } from "./logger.js";

function embedText(embeds = []) {
  return (embeds || [])
    .map((e) =>
      [
        e.title,
        e.description,
        e.url,
        e.author?.name,
        e.footer?.text,
        ...(e.fields || []).map((f) => `${f.name} ${f.value}`),
      ].join("\n")
    )
    .join("\n");
}

let client = null;

/**
 * Listen to a Discord channel (PikaNotify, cook groups, TrackaLack communities)
 * and forward restock messages to the engine — no Target browser scraping.
 */
export async function startDiscordBridge(engine, config) {
  const bridge = config.monitor?.discordBridge;
  if (!bridge?.enabled) return null;

  const token = bridge.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log.warn("Discord bridge enabled but no bot token — set monitor.discordBridge.botToken or DISCORD_BOT_TOKEN.");
    return null;
  }

  let discord;
  try {
    discord = await import("discord.js");
  } catch {
    log.warn("Discord bridge requires discord.js — run: npm install discord.js");
    return null;
  }

  const { Client, GatewayIntentBits, Events, Partials } = discord;
  const channelIds = new Set((bridge.channelIds || []).map(String));
  if (!channelIds.size) {
    log.warn("Discord bridge: add monitor.discordBridge.channelIds (channel IDs to watch).");
    return null;
  }

  if (client) {
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on(Events.ClientReady, (c) => {
    log.ok(`Discord bridge connected as ${c.user.tag} — watching ${channelIds.size} channel(s).`);
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (!channelIds.has(msg.channelId)) return;

    const botsOnly = bridge.botsOnly === true;
    const isBot = msg.author?.bot || msg.webhookId;
    if (botsOnly && !isBot) return;

    const alerts = parseStockAlert(
      {
        text: msg.content,
        embeds: msg.embeds?.map((e) => ({
          title: e.title,
          description: e.description,
          url: e.url,
          author: e.author ? { name: e.author.name } : undefined,
          footer: e.footer ? { text: e.footer.text } : undefined,
          fields: e.fields?.map((f) => ({ name: f.name, value: f.value })),
        })),
        source: "discord",
      },
      { requireRestockHint: bridge.requireRestockHint === true }
    );

    if (!alerts.length) return;

    const posted = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString() : "unknown";
    log.hit(`Discord alert in #${msg.channelId} at ${posted} — ${alerts.length} product(s) — launching checkout NOW`);

    for (const alert of alerts) {
      try {
        await engine.handleExternalAlert({ ...alert, text: `${msg.content}\n${embedText(msg.embeds)}` });
      } catch (err) {
        log.err(`Discord alert failed: ${err.message}`);
      }
    }
  });

  await client.login(token);
  return client;
}

export async function stopDiscordBridge() {
  if (!client) return;
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
  client = null;
}
