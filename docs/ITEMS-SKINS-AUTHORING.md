# Items & Skins Authoring Guide

How to author **character skins**, **item definitions**, and **item skins**
for XANDRIA — by hand (JSON), by code (`SkinBuilder` / `ItemBuilder`), or by
clicking (Studio **Creators** tab).

All shapes live in `xandria-studio/src/spec/schema.ts` and are checked by
`validateSpec`. Every rule below is enforced by the validator; the error
catalog in §5 quotes the validator's actual `path: message` strings.

## 1. Character skins (`custom.characters.skins`)

```jsonc
// custom.characters.skins.ember
{
  "name": "Ember Warden",
  "palette": { "skin": "#d9a066", "shirt": "#5a1f1f", "pants": "#241a1a", "accent": "#ff7700" },
  "emissive": { "color": "#ff7700", "intensity": 2 },
  "roughness": 0.4,
  "metalness": 0.2,
  "texture": { "pattern": "carbon" },
  "textureRoles": ["shirt", "pants"]
}
```

- `name` — display name, required.
- `palette` — per-role color overrides (`#rrggbb`). Roles: `skin`, `shirt`,
  `pants`, `accent`. Applied to the rig's owned, cloned materials; an
  explicit skin on a character slot **wins** over the palette-derived colors.
- `emissive` — glow on the **accent** role materials. `intensity` 0..5.
- `roughness` / `metalness` — 0..1, applied to all of the rig's owned materials.
- `texture` — either `{ "url": "https://…/tex.png" }` (https,
  `.png/.jpg/.jpeg/.webp`) or `{ "pattern": "carbon" }` (named canvas pattern).
  Texture failures never throw — the plain palette stands as fallback.
- `textureRoles` — which body roles get the map; default `["shirt", "pants"]`.
  Roles: `skin|shirt|pants|accent|accentDS`.

Pattern set (`SKIN_TEXTURE_PATTERNS`): `camo`, `stripes`, `digital`,
`carbon`, `hazard`, `fade`, `runes`. Painters are 128px deterministic canvas
luminance layers, so the palette hue shows through; `hazard` is chromatic
(yellow/black) and meant for accents.

Character slot (how a skin gets *used*):

```jsonc
// custom.characters.player
{
  "skin": "ember",
  "model": "https://cdn.example.com/hero.glb",
  "boneMap": { "armL": "LeftArm", "legR": "RightUpLeg" }
}
```

`model` is an https `.glb/.gltf` URL that replaces the procedural rig
(online-only; procedural fallback always). `boneMap` maps pivots
(`legL|legR|armL|armR|torso|head|elbowL|elbowR|kneeL|kneeR`) to node names in
the model. Skins are procedural-only: on an imported GLB rig a skin is a
no-op.

## 2. Item definitions (`custom.items.defs`)

```jsonc
// custom.items.defs.ember_blade
{
  "name": "Ember Blade",
  "type": "weapon",
  "slot": "weapon",
  "rarity": "rare",
  "stats": { "damage": 12, "crit": 0.05 },
  "skin": "ember",
  "stack": 1,
  "value": 250,
  "description": "A blade that still remembers the forge."
}
```

- `type` — `weapon|armor|consumable|material|key|trinket`.
- `slot` — `weapon|head|torso|legs|accessory`; **required** for weapon/armor.
- `rarity` — `common|uncommon|rare|epic|legendary` (default `common`); drives
  world-item glow color + particle shimmer.
- `stats` — additive equip bonuses; keys
  `damage|defense|speed|maxHealth|crit|attackSpeed|luck`, finite numbers
  -1000..10000.
- `behavior` (consumables): `{ "effect": "heal", "amount": 40 }`,
  `{ "effect": "restore", "amount": 25 }`, or
  `{ "effect": "buff", "amount": 0.2, "duration": 30 }` (duration 0 = instant).
- `skin` — item-skin id (built-in or `custom.items.skins`).
- `model` — https `.glb/.gltf` URL mesh override (online-only, procedural
  fallback).
- `stack` — max stack size, integer 1..999 (default 1).
- `value` — coin/vendor value, ≥ 0. `description` — ≤ 280 chars.

Loot placement and chests reference **def ids** — unknown ids are hard
errors, so typos never ship silently:

```jsonc
// custom.items.loot
[{ "item": "ember_blade", "pos": [12, 0, -4], "count": 1 }],
// custom.items.chests
[{ "pos": [30, 0, 10], "loot": ["ember_blade", "health_potion"], "locked": true, "skin": "ember" }]
// custom.items.starting
["health_potion"]
```

## 3. Item skins (`custom.items.skins`)

```jsonc
// custom.items.skins.ember
{
  "name": "Ember Blade Skin",
  "palette": { "primary": "#8a1f1f", "secondary": "#2a1414", "glow": "#ff7700" },
  "emissive": { "color": "#ff7700", "intensity": 1.5 },
  "roughness": 0.45,
  "metalness": 0.4,
  "texture": { "pattern": "runes" },
  "textureRoles": ["primary"]
}
```

Same shape as character skins, but the palette roles are
`primary|secondary|glow` (mapped onto the item mesh's
`userData.role`-tagged materials; unmapped roles keep the mesh default) and
`textureRoles` uses the same item role set.

## 4. Code-first authoring

```ts
import { SkinBuilder } from './engine/gfx/SkinBuilder';
import { ItemBuilder } from './engine/game/items/ItemBuilder';

// character skin
const skin = new SkinBuilder('ember')
  .displayName('Ember Warden')
  .palette({ shirt: '#5a1f1f', accent: '#ff7700' })
  .pattern('carbon')
  .emissive('#ff7700', 2)
  .roughness(0.4)
  .metalness(0.2)
  .build(); // SkinDef

// item-skin variant (roles primary|secondary|glow)
const itemSkin = new SkinBuilder('ember')
  .displayName('Ember Blade')
  .forItem()
  .palette({ primary: '#8a1f1f', glow: '#ff7700' })
  .emissive('#ff7700', 1.5)
  .build(); // ItemSkinDef

// item
const sword = new ItemBuilder('ember_blade')
  .named('Ember Blade')
  .weapon('weapon')        // type=weapon, slot=weapon
  .stat('damage', 12)
  .rarity('rare')
  .skin('ember')
  .stackable(1)
  .build(); // ItemDef

// validate() wraps the REAL validateSpec on a synthetic spec.
// Empty array = the def is spec-clean.
const errors: string[] = new ItemBuilder('x').named('X').validate();
// -> ['custom.items.defs.__item_builder__.type: builder never chose a type — call .type(), .weapon(), ...']
```

`SkinBuilder`/`ItemBuilder` never throw on `.build()`; check `.validate()`
before shipping the def. Shorthands: `.type(t)`, `.weapon(slot?)`,
`.armor(slot?)`, `.consumable()`, `.material()`, `.key()`, `.trinket()`,
`.behavior(effect, amount?, duration?)`, `.textureUrl(url)`,
`.textureRoles([...])`, `.paletteRole(role, color)`.

## 5. Validation error catalog

Quoted verbatim from `validateSpec` (schema.ts). `<id>` / `<i>` are the
skin/item id and the loot index.

### Character skins — `custom.characters.skins.<id>`

| Path | Message |
|---|---|
| `custom.characters.skins.<id>` | `must be an object` |
| `…​.name` | `must be a non-empty string` |
| `…​.palette` | `must be an object` |
| `…​.palette.<role>` | `unknown role (skin\|shirt\|pants\|accent)` |
| `…​.palette.<role>` | `must be #rrggbb` |
| `…​.emissive` | `must be an object` |
| `…​.emissive.color` | `must be #rrggbb` |
| `…​.emissive.intensity` | `must be 0..5` |
| `…​.roughness` | `must be 0..1` |
| `…​.metalness` | `must be 0..1` |
| `…​.texture` | `must be an object` |
| `…​.texture` | `must be { url } or { pattern }` |
| `…​.texture.url` | `must be an https URL ending in .png/.jpg/.jpeg/.webp` |
| `…​.texture.pattern` | `must be one of camo\|stripes\|digital\|carbon\|hazard\|fade\|runes` |
| `…​.textureRoles` | `must be an array of skin\|shirt\|pants\|accent\|accentDS` |

Character slots (`custom.characters.player`, `custom.characters.enemies.<k>`):

- `<path>.skin`: `must be a non-empty skin id`
- `<path>.model`: `must be an https URL ending in .glb/.gltf`
- `<path>.boneMap`: `must be an object`
- `<path>.boneMap.<pivot>`: `unknown pivot (legL|legR|armL|armR|torso|head|elbowL|elbowR|kneeL|kneeR)`
- `<path>.boneMap.<pivot>`: `must be a non-empty node name`

### Item defs — `custom.items.defs.<id>`

| Path | Message |
|---|---|
| `custom.items.defs.<id>` | `must be an object` |
| `…​.name` | `must be a non-empty string` |
| `…​.name` | `must be <= 48 chars` |
| `…​.type` | `must be one of weapon\|armor\|consumable\|material\|key\|trinket` |
| `…​.slot` | `must be one of weapon\|head\|torso\|legs\|accessory` |
| `…​.slot` | `required for weapon/armor items` |
| `…​.rarity` | `must be one of common\|uncommon\|rare\|epic\|legendary` |
| `…​.stats` | `must be an object` |
| `…​.stats.<key>` | `unknown stat (damage\|defense\|speed\|maxHealth\|crit\|attackSpeed\|luck)` |
| `…​.stats.<key>` | `must be a finite number -1000..10000` |
| `…​.behavior` | `must be an object` |
| `…​.behavior.effect` | `must be heal\|restore\|buff` |
| `…​.behavior.amount` | `must be a number 0..100000` |
| `…​.behavior.duration` | `must be a number 0..3600` |
| `…​.skin` | `must be a non-empty item-skin id` |
| `…​.model` | `must be an https URL ending in .glb/.gltf` |
| `…​.stack` | `must be an integer 1..999` |
| `…​.value` | `must be a number >= 0` |
| `…​.description` | `must be a string` |
| `…​.description` | `must be <= 280 chars` |

### Item skins — `custom.items.skins.<id>`

Same messages as character skins, except:

- `…​.palette.<role>`: `unknown role (primary\|secondary\|glow)`
- `…​.textureRoles`: `must be an array of primary\|secondary\|glow`

### Loot & chests

- `custom.items.loot`: `must be an array`
- `custom.items.loot[<i>]`: `must be an object`
- `custom.items.loot[<i>].item`: `must be a non-empty item id`
- `custom.items.loot[<i>].item`: `unknown item id "<id>" (not in custom.items.defs)`
- `custom.items.loot[<i>].pos`: `must be [x, y, z] numbers`
- `custom.items.loot[<i>].count`: `must be an integer >= 1`
- `custom.items.chests`: `must be an array`
- `custom.items.chests[<i>]`: `must be an object`
- `custom.items.chests[<i>].pos`: `must be [x, y, z] numbers`
- `custom.items.chests[<i>].loot`: `must be a non-empty array of item ids`
- `custom.items.chests[<i>].loot[<j>]`: `unknown item id "<id>" (not in custom.items.defs)`
- `custom.items.chests[<i>].locked`: `must be boolean`
- `custom.items.chests[<i>].skin`: `must be a non-empty item-skin id`

### Containers

- `custom.items`: `must be an object`
- `custom.items.defs` / `custom.items.skins`: `must be an object`
- `custom.characters`: `must be an object`
- `custom.characters.skins` / `custom.characters.enemies`: `must be an object`

## 6. Studio: the Creators tab (basic users)

The Studio editor has a **Creators** tab with two visual tools:

- **Skin Creator** — target toggle (character/item), color pickers per
  palette role, pattern select, emissive/roughness/metalness sliders, and a
  live 3D turntable preview of a preview mannequin. Export: download JSON,
  copy-to-clipboard, or **Add to spec** (writes to
  `custom.characters.skins` / `custom.items.skins`).
- **Item Editor** — form for every ItemDef field, skin-id field with a
  CHECK button, model-URL field with a Supabase **⬆ UPLOAD** button, a stub
  mesh preview (rarity-colored box + label — the deluxe forge is a separate
  crew's work), and **Place in world** (appends to `custom.items.loot`).

Upload buttons also sit next to the character **model-URL inputs** (player,
walker, brute) on the editor's character cards.

## 7. Uploads (Supabase Storage)

File picker accepts `.glb,.gltf,.png,.jpg,.jpeg,.webp`. Files go to the
`xandria-uploads` bucket (override with `VITE_SUPABASE_UPLOAD_BUCKET`),
path `uploads/<timestamp>-<rand>-<name>`; the public URL is written back
into the URL field. Setup requirements:

1. Create the bucket in your Supabase project (Storage → New bucket) and
   mark it **public** so public URLs resolve.
2. Add an INSERT storage policy for your users (anon or authenticated).
3. Set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` at build time.

No Supabase configured → the upload button renders **disabled** with a
tooltip explaining what's missing; the URL text field always works.
Upload errors (size > 50 MB, network, policy) show as inline text — the
button never throws.

## 8. Offline behavior (honest)

- **URL textures** (`texture.url`) and **GLB/GLTF models** (character
  `model`, item `model`) need network at load time. Offline they fail
  silently and the **procedural fallback** takes over — a skin's palette on
  the procedural rig, a procedural mesh for items. Nothing throws.
- **Named patterns** (`texture.pattern`) are generated on a canvas at
  runtime — they work fully offline.
- **Uploads** need network. Everything else in this guide (palettes,
  emissive, stats, builders, the Studio creators, validation) is offline-safe.
