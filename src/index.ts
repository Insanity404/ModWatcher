import { writeSync } from 'node:fs';
import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { FeedClient } from './feed/client.js';
import { loadMarkEmojis } from './marks.js';
import { StateStore } from './state/store.js';
import { Watcher } from './watcher.js';
import { commandData, handleInteraction, type CommandContext } from './commands/index.js';
import { VERSION } from './version.js';

if (process.argv.includes('--version')) {
  writeSync(1, `${VERSION}\n`);
  process.exit(0);
}

const config = loadConfig();
logger.info({ version: VERSION, node: process.versions.node }, 'Mod Watcher starting');

// Logged instead of Node's default, which would take the whole bot down over one stray promise.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

let state: StateStore;
try {
  state = await StateStore.open(config.STATE_PATH);
} catch (error) {
  logger.fatal({ err: error }, 'could not open the state file');
  process.exit(1);
}

const feed = new FeedClient(config.FEED_URL, config.FEED_KEY, logger);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  presence: config.STATUS_TEXT
    ? {
        activities: [{ type: ActivityType.Custom, name: 'status', state: config.STATUS_TEXT }],
      }
    : undefined,
});

const watcher = new Watcher(client, config, state, feed, logger);
const ctx: CommandContext = { client, config, state, watcher, feed, logger };

/** Emojis added to the application later are picked up without a restart. */
const MARK_EMOJI_REFRESH_MS = 6 * 60 * 60_000;

client.once(Events.ClientReady, (ready) => {
  logger.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected');
  void ready.application.commands
    .set(commandData())
    .catch((error) => logger.error({ err: error }, 'command registration failed'));
  // A refresh that fails keeps the emojis already in use.
  const refreshMarks = async () => {
    const emojis = await loadMarkEmojis(ready, logger);
    if (emojis) watcher.setMarkEmojis(emojis);
  };
  void refreshMarks().finally(() => watcher.start());
  setInterval(() => void refreshMarks(), MARK_EMOJI_REFRESH_MS).unref();
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(interaction, ctx).catch((error) =>
    logger.error({ err: error }, 'interaction handler threw'),
  );
});

client.on(Events.GuildDelete, (guild) => {
  void state
    .clearBinding(guild.id)
    .catch((error) =>
      logger.error({ err: error, guildId: guild.id }, 'could not clear the binding'),
    );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    watcher.stop();
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(config.DISCORD_TOKEN);
