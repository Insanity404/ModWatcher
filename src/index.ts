import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { FeedClient } from './feed/client.js';
import { StateStore } from './state/store.js';
import { Watcher } from './watcher.js';
import { commandData, handleInteraction, type CommandContext } from './commands/index.js';

const config = loadConfig();

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
        activities: [
          { type: ActivityType.Custom, name: 'status', state: config.STATUS_TEXT },
        ],
      }
    : undefined,
});

const watcher = new Watcher(client, config, state, feed, logger);
const ctx: CommandContext = { client, config, state, watcher, feed, logger };

client.once(Events.ClientReady, (ready) => {
  logger.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected');
  void ready.application.commands
    .set(commandData())
    .catch((error) => logger.error({ err: error }, 'command registration failed'));
  watcher.start();
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(interaction, ctx).catch((error) =>
    logger.error({ err: error }, 'interaction handler threw'),
  );
});

client.on(Events.GuildDelete, (guild) => {
  void state.clearBinding(guild.id);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    watcher.stop();
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(config.DISCORD_TOKEN);
