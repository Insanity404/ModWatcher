import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  FEED_KEY: z
    .string()
    .regex(/^arty_[0-9a-f]{32}$/, 'expected an arty_… key from 7d2dmodding.com'),
  FEED_URL: z.string().url().default('https://7d2dmodding.com/api/feed'),
  STATE_PATH: z.string().min(1).default('./data/state.json'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(300),
  STATUS_TEXT: z.string().max(128).optional(),
});

export type BotConfig = z.infer<typeof schema>;

export function loadConfig(): BotConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Configuration is invalid:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.') || '(env)'}: ${issue.message}`);
    }
    console.error('See .env.example for the full list.');
    process.exit(1);
  }
  return parsed.data;
}
