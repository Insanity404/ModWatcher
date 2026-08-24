import { pino } from 'pino';
import pretty from 'pino-pretty';

const rawJson = /^(1|true|yes|on)$/i.test(process.env.LOG_JSON ?? '');
const level = process.env.LOG_LEVEL ?? 'info';

const SKIP_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v']);
const ERROR_KEYS = new Set(['err', 'error']);

function renderValue(value: unknown): string {
  if (typeof value === 'string') return /\s/.test(value) ? `"${value}"` : value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value) ?? '';
  return String(value);
}

function formatMessage(log: Record<string, unknown>, messageKey: string): string {
  const details: string[] = [];
  const traces: string[] = [];

  for (const [key, value] of Object.entries(log)) {
    if (SKIP_KEYS.has(key) || value === undefined || value === null) continue;
    if (ERROR_KEYS.has(key) && typeof value === 'object') {
      const err = value as { message?: unknown; type?: unknown; stack?: unknown };
      details.push(`${key}=${renderValue(String(err.message ?? err.type ?? 'error'))}`);
      if (typeof err.stack === 'string') traces.push(err.stack);
      continue;
    }
    details.push(`${key}=${renderValue(value)}`);
  }

  const head = String(log[messageKey] ?? '');
  const line = details.length ? `${head}  ${details.join(' ')}` : head;
  return traces.length ? `${line}\n${traces.join('\n')}` : line;
}

export const logger = rawJson
  ? pino({ level })
  : pino(
      { level },
      pretty({
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
        hideObject: true,
        messageFormat: (log, messageKey) => formatMessage(log, messageKey),
      }),
    );

export type Logger = typeof logger;
