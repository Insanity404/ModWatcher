import {
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
} from 'discord.js';

export type PostOutcome = 'sent' | 'missingChannel' | 'missingPermissions' | 'failed';

export function resolvePostChannel(client: Client, channelId: string): GuildTextBasedChannel | null {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel;
}

export function canPostIn(channel: GuildTextBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  const permissions = channel.permissionsFor(me);
  return permissions.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages);
}

export async function postComponents(
  client: Client,
  channelId: string,
  components: object[],
): Promise<PostOutcome> {
  const channel = resolvePostChannel(client, channelId);
  if (!channel) return 'missingChannel';
  if (!canPostIn(channel)) return 'missingPermissions';

  try {
    await channel.send({
      components: components as never,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}
