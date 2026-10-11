/**
 * SkinBuilder — code-first fluent API for authoring character skins and
 * item skins. Produces the plain SkinDef / ItemSkinDef object shapes from
 * src/spec/schema.ts (commit 513fa6a); `.validate()` runs the REAL
 * `validateSpec` validator over a synthetic spec, so a builder that
 * validates clean will pass the same checks the Studio and generator use.
 *
 * Example:
 *   const skin = new SkinBuilder('ember')
 *     .displayName('Ember Warden')
 *     .palette({ skin: '#d9a066', shirt: '#5a1f1f', pants: '#241a1a', accent: '#ff7700' })
 *     .pattern('carbon')
 *     .emissive('#ff7700', 2)
 *     .roughness(0.4)
 *     .build();            // SkinDef
 *
 *   const itemSkin = new SkinBuilder('ember')
 *     .displayName('Ember Blade')
 *     .forItem()           // → ItemSkinBuilder (roles: primary|secondary|glow)
 *     .palette({ primary: '#8a1f1f', glow: '#ff7700' })
 *     .emissive('#ff7700', 1.5)
 *     .build();            // ItemSkinDef
 *
 * `.build()` never throws (mirrors the skins philosophy: a bad skin is a
 * no-op). `.validate()` returns the actual `path: message` validator
 * strings; an empty array means the def is spec-clean.
 */
import {
  SKIN_TEXTURE_PATTERNS, SKIN_TEXTURE_ROLES, ITEM_SKIN_ROLES,
  type SkinDef, type SkinPalette, type SkinTexturePattern, type SkinTextureRole,
  type ItemSkinDef, type ItemSkinRole,
  defaultSpec, validateSpec,
} from '@spec';

/** id for the synthetic skin slot inside the synthetic spec used by validate() */
const SYNTH_ID = '__skin_builder__';

export class SkinBuilder {
  protected readonly id: string;
  protected def: SkinDef;

  constructor(id: string) {
    this.id = id;
    this.def = { name: id };
  }

  /** Display name (required — validator rejects empty names). */
  displayName(name: string): this {
    this.def.name = name;
    return this;
  }

  /** Per-role color overrides (#rrggbb). Roles: skin|shirt|pants|accent. */
  palette(p: Partial<SkinPalette>): this {
    this.def.palette = { ...(this.def.palette ?? {}), ...p };
    return this;
  }

  /** Single-role palette convenience. */
  paletteRole(role: keyof SkinPalette, color: string): this {
    this.def.palette = { ...(this.def.palette ?? {}), [role]: color };
    return this;
  }

  /** Emissive accent glow (#rrggbb color, 0..5 intensity), applied to accent-role materials. */
  emissive(color: string, intensity = 1): this {
    this.def.emissive = { color, intensity };
    return this;
  }

  /** 0..1 — higher = matte. */
  roughness(v: number): this {
    this.def.roughness = v;
    return this;
  }

  /** 0..1 — higher = metallic. */
  metalness(v: number): this {
    this.def.metalness = v;
    return this;
  }

  /** Named canvas-procedural pattern (camo|stripes|digital|carbon|hazard|fade|runes). */
  pattern(p: SkinTexturePattern): this {
    this.def.texture = { pattern: p };
    return this;
  }

  /** URL texture (https, .png/.jpg/.jpeg/.webp). Needs network at load; palette is the fallback. */
  textureUrl(url: string): this {
    this.def.texture = { url };
    return this;
  }

  /** Which body roles get the texture map (default: shirt+pants). */
  textureRoles(roles: SkinTextureRole[]): this {
    this.def.textureRoles = [...roles];
    return this;
  }

  /** The finished def — plain JSON-serializable object. Never throws. */
  build(): SkinDef {
    return { ...this.def, palette: this.def.palette ? { ...this.def.palette } : undefined };
  }

  /**
   * Validate the built def with the real spec validator on a synthetic spec.
   * Returns `path: message` error strings (empty = valid).
   */
  validate(): string[] {
    const spec = defaultSpec(1);
    spec.custom = {
      ...(spec.custom ?? {}),
      characters: { ...(spec.custom?.characters ?? {}), skins: { [SYNTH_ID]: this.build() } },
    };
    return validateSpec(spec).errors;
  }

  /**
   * Item-skin variant: carries displayName, emissive, roughness, metalness
   * and a pattern texture (not textureRoles/palette — item skins use the
   * primary|secondary|glow role set, so the palette is re-specified).
   */
  forItem(): ItemSkinBuilder {
    const b = new ItemSkinBuilder(this.id);
    if (this.def.name !== this.id) b.displayName(this.def.name);
    if (this.def.emissive) b.emissive(this.def.emissive.color, this.def.emissive.intensity);
    if (typeof this.def.roughness === 'number') b.roughness(this.def.roughness);
    if (typeof this.def.metalness === 'number') b.metalness(this.def.metalness);
    if (this.def.texture && 'pattern' in this.def.texture) b.pattern(this.def.texture.pattern);
    return b;
  }
}

export class ItemSkinBuilder {
  protected readonly id: string;
  protected def: ItemSkinDef;

  constructor(id: string) {
    this.id = id;
    this.def = { name: id };
  }

  displayName(name: string): this {
    this.def.name = name;
    return this;
  }

  /** Per-role color overrides (#rrggbb). Roles: primary|secondary|glow. */
  palette(p: Partial<Record<ItemSkinRole, string>>): this {
    this.def.palette = { ...(this.def.palette ?? {}), ...p };
    return this;
  }

  paletteRole(role: ItemSkinRole, color: string): this {
    this.def.palette = { ...(this.def.palette ?? {}), [role]: color };
    return this;
  }

  emissive(color: string, intensity = 1): this {
    this.def.emissive = { color, intensity };
    return this;
  }

  roughness(v: number): this {
    this.def.roughness = v;
    return this;
  }

  metalness(v: number): this {
    this.def.metalness = v;
    return this;
  }

  pattern(p: SkinTexturePattern): this {
    this.def.texture = { pattern: p };
    return this;
  }

  textureUrl(url: string): this {
    this.def.texture = { url };
    return this;
  }

  textureRoles(roles: ItemSkinRole[]): this {
    this.def.textureRoles = [...roles];
    return this;
  }

  build(): ItemSkinDef {
    return { ...this.def, palette: this.def.palette ? { ...this.def.palette } : undefined };
  }

  validate(): string[] {
    const spec = defaultSpec(1);
    spec.custom = {
      ...(spec.custom ?? {}),
      items: { ...(spec.custom?.items ?? {}), skins: { [SYNTH_ID]: this.build() } },
    };
    return validateSpec(spec).errors;
  }
}

/** Re-export the pattern/role sets for the pattern-picker UI. */
export { SKIN_TEXTURE_PATTERNS, SKIN_TEXTURE_ROLES, ITEM_SKIN_ROLES };
export type { SkinTexturePattern, SkinTextureRole, ItemSkinRole };
