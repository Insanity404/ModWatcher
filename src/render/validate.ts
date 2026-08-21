export const RENDER_VERSION = 1;

const enum Type {
  ActionRow = 1,
  Button = 2,
  Section = 9,
  TextDisplay = 10,
  Thumbnail = 11,
  MediaGallery = 12,
  Separator = 14,
  Container = 17,
}

const BUTTON_STYLE_LINK = 5;
const MAX_TOTAL_TEXT = 4000;
const MAX_COMPONENTS = 40;

export type RenderValidation =
  | { ok: true; components: object[] }
  | { ok: false; reason: string };

type Ctx = { componentCount: number; textTotal: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function checkMedia(value: unknown): string | null {
  if (!isRecord(value)) return 'media must be an object';
  if (!isHttpsUrl(value.url)) return 'media url must be https';
  return null;
}

function checkButton(value: Record<string, unknown>): string | null {
  if (value.style !== BUTTON_STYLE_LINK) return 'only link buttons are allowed';
  if (!isHttpsUrl(value.url)) return 'button url must be https';
  if (typeof value.label !== 'string' || !value.label || value.label.length > 80) {
    return 'button label missing or too long';
  }
  return null;
}

function checkComponent(value: unknown, ctx: Ctx, insideContainer: boolean): string | null {
  if (!isRecord(value)) return 'component must be an object';
  if ('custom_id' in value || 'customId' in value) return 'custom_id is not allowed';
  if ((ctx.componentCount += 1) > MAX_COMPONENTS) return 'too many components';

  switch (value.type) {
    case Type.TextDisplay: {
      if (typeof value.content !== 'string' || !value.content.length) {
        return 'text display needs content';
      }
      if ((ctx.textTotal += value.content.length) > MAX_TOTAL_TEXT) {
        return 'total text exceeds the Discord limit';
      }
      return null;
    }
    case Type.Separator:
      return null;
    case Type.Thumbnail:
      return checkMedia(value.media);
    case Type.MediaGallery: {
      if (!Array.isArray(value.items) || !value.items.length || value.items.length > 10) {
        return 'media gallery needs 1-10 items';
      }
      for (const item of value.items) {
        if (!isRecord(item)) return 'gallery item must be an object';
        const problem = checkMedia(item.media);
        if (problem) return problem;
      }
      return null;
    }
    case Type.Button:
      return checkButton(value);
    case Type.ActionRow: {
      if (!Array.isArray(value.components) || !value.components.length || value.components.length > 5) {
        return 'action row needs 1-5 components';
      }
      for (const child of value.components) {
        if (!isRecord(child) || child.type !== Type.Button) return 'action rows may hold only buttons';
        const problem = checkComponent(child, ctx, insideContainer);
        if (problem) return problem;
      }
      return null;
    }
    case Type.Section: {
      if (!Array.isArray(value.components) || !value.components.length || value.components.length > 3) {
        return 'section needs 1-3 text components';
      }
      for (const child of value.components) {
        if (!isRecord(child) || child.type !== Type.TextDisplay) {
          return 'sections may hold only text displays';
        }
        const problem = checkComponent(child, ctx, insideContainer);
        if (problem) return problem;
      }
      if (value.accessory !== undefined) {
        if (!isRecord(value.accessory)) return 'section accessory must be an object';
        if (value.accessory.type !== Type.Thumbnail && value.accessory.type !== Type.Button) {
          return 'section accessory must be a thumbnail or link button';
        }
        return checkComponent(value.accessory, ctx, insideContainer);
      }
      return null;
    }
    case Type.Container: {
      if (insideContainer) return 'containers may not nest';
      if (!Array.isArray(value.components) || !value.components.length) {
        return 'container needs components';
      }
      if (value.accent_color !== undefined && typeof value.accent_color !== 'number') {
        return 'accent_color must be a number';
      }
      for (const child of value.components) {
        const problem = checkComponent(child, ctx, true);
        if (problem) return problem;
      }
      return null;
    }
    default:
      return `component type ${String(value.type)} is not allowed`;
  }
}

export function validateRender(payload: unknown): RenderValidation {
  if (!isRecord(payload)) return { ok: false, reason: 'render payload missing' };
  if (payload.version !== RENDER_VERSION) {
    return { ok: false, reason: `unknown render version ${String(payload.version)}` };
  }
  if (!Array.isArray(payload.components) || !payload.components.length) {
    return { ok: false, reason: 'render payload has no components' };
  }

  const ctx: Ctx = { componentCount: 0, textTotal: 0 };
  for (const component of payload.components) {
    const problem = checkComponent(component, ctx, false);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, components: payload.components as object[] };
}
