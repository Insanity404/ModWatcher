import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { BotConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { FeedClient } from '../feed/client.js';
import { canPostIn, resolvePostChannel } from '../poster/post.js';
import { validateRender } from '../render/validate.js';
import type { StateStore } from '../state/store.js';
import type { Watcher } from '../watcher.js';

export type CommandContext = {
  client: Client;
  config: BotConfig;
  state: StateStore;
  watcher: Watcher;
  feed: FeedClient;
  logger: Logger;
};

export function commandData(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Choose the channel for mod update posts (run with no channel to check).')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel to post mod updates in')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('How the mod watcher is doing (visible only to you).')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('collection')
      .setDescription('Mod collections from 7d2dmodding.com')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('show')
          .setDescription('Share a mod collection in this channel.')
          .addStringOption((option) =>
            option
              .setName('link')
              .setDescription('A 7d2dmodding.com share link, or just the collection slug')
              .setRequired(true),
          ),
      )
      .toJSON(),
  ];
}

export async function handleInteraction(interaction: Interaction, ctx: CommandContext): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  switch (interaction.commandName) {
    case 'setup':
      return handleSetup(interaction, ctx);
    case 'status':
      return handleStatus(interaction, ctx);
    case 'collection':
      return handleCollectionShow(interaction, ctx);
    default:
      return;
  }
}

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  if (!interaction.inGuild()) return;
  const choice = interaction.options.getChannel('channel', false, [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
  ]);

  if (!choice) {
    const bound = ctx.state.bindingFor(interaction.guildId);
    await interaction.reply({
      content: bound
        ? `Mod updates post in <#${bound}>.${describeChannelHealth(ctx.client, bound)}`
        : 'No channel yet — run `/setup channel:#your-channel` to pick one.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = resolvePostChannel(ctx.client, choice.id);
  if (!channel || !canPostIn(channel)) {
    await interaction.reply({
      content:
        `I can't post in <#${choice.id}> yet — I need **View Channel** and **Send Messages** ` +
        'there. Grant those two and run `/setup` again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await ctx.state.setBinding(interaction.guildId, choice.id);
  ctx.logger.info({ guildId: interaction.guildId, channelId: choice.id }, 'channel bound');
  await interaction.reply({
    content: `Done — mod updates will post in <#${choice.id}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

function describeChannelHealth(client: Client, channelId: string): string {
  const channel = resolvePostChannel(client, channelId);
  if (!channel) return ' ⚠ I can no longer see that channel — run `/setup` to rebind.';
  if (!canPostIn(channel)) {
    return ' ⚠ I am missing **View Channel** or **Send Messages** there.';
  }
  return '';
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  if (!interaction.inGuild()) return;
  const status = ctx.watcher.status();
  const bound = ctx.state.bindingFor(interaction.guildId);
  const feedHost = new URL(ctx.config.FEED_URL).host;

  const stamp = (iso: string | null) => (iso ? time(new Date(iso), 'R') : 'never');
  const lines = [
    `**Feed** (${feedHost}): last poll ${stamp(status.lastPollAt)} — ${
      status.lastPollOk ? 'OK' : (status.lastProblem ?? 'not yet polled')
    }`,
    `**Next poll:** ${stamp(status.nextPollAt)}`,
    `**Last update posted:** ${stamp(status.lastPostAt)}`,
    `**This server:** ${
      bound
        ? `posting in <#${bound}>${describeChannelHealth(ctx.client, bound)}`
        : 'no channel bound — run `/setup`'
    }`,
  ];

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

function parseCollectionSlug(input: string): string | null {
  const fromLink = /\/c\/([A-Za-z0-9_-]+)/.exec(input);
  if (fromLink?.[1]) return fromLink[1];
  return /^[A-Za-z0-9_-]{1,80}$/.test(input.trim()) ? input.trim() : null;
}

async function handleCollectionShow(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  if (interaction.options.getSubcommand() !== 'show') return;

  const slug = parseCollectionSlug(interaction.options.getString('link', true));
  if (!slug) {
    await interaction.reply({
      content: 'That does not look like a 7d2dmodding.com collection link or slug.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const result = await ctx.feed.getCollection(slug);
  const render = result.ok ? validateRender(result.response.render) : null;

  if (!result.ok || !render?.ok) {
    if (!result.ok && result.kind !== 'notFound') {
      ctx.logger.warn({ slug, kind: !result.ok ? result.kind : 'render' }, 'collection fetch failed');
    }
    await interaction.deleteReply().catch(() => {});
    await interaction
      .followUp({
        content:
          !result.ok && result.kind === 'notFound'
            ? 'No shared collection with that link — check it on 7d2dmodding.com.'
            : "Couldn't fetch that collection right now — try again in a bit.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  await interaction.editReply({
    components: render.components as never,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}
