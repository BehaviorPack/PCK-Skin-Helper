### PCK Skin Helper V5

| # | What changed | Why |
|---|---|---|
| 1 | `BEDROCK_TEMPLATE_SLIM` — `rightArm`/`leftArm` UVs swapped from `[32,48]`/`[40,16]` → `[40,16]`/`[32,48]`; `rightSleeve`/`leftSleeve` swapped from `[48,48]`/`[40,32]` → `[40,32]`/`[48,48]` | Slim template had left/right UVs inverted, causing wrong texture sampling on exported slim skins |
| 2 | `BEDROCK_OVERLAY_REMOVE_FLAGS` — removed `_DISABLED` base bits, kept only `_OVERLAY_DISABLED` bits | Base-disabled flag (e.g. custom arm geometry) was incorrectly stripping the sleeve/jacket/hat overlay bones from the export |
| 3 | `locatorPositions`, `LOCATOR_GATED_BONES`, `BEDROCK_BONE_TO_PCK_BONE`, `liveBonePivot` — all hoisted above the cube collection loop | Required by the new cube Y correction and armor fallback logic; caused `ReferenceError` when defined after the loop that needed them |
| 4 | Cube origin Y correction — `origin[1]` adjusted by `defaultPivotY − livePivotY` | `pck_importer` over-shifts cube Y when a bone has a negative Y offset (arm/head moved up), placing custom cubes 1+ units too high in the Bedrock output |
| 5 | Armor-masked cube fallback — cubes with `pck_armor_mask` now fall back to the base bone when their target armor sub-bone has no locator | All custom geometry was silently dropped for skins imported without armor locators (the majority of standard PCK skins) |
| 6 | Limb pivot X formula — replaced cube-geometry-edge approach with `templatePivotX − (livePCKX − defaultPCKX)` | Pivot is a joint position, not a bounding box edge; the old approach produced wrong pivots whenever custom cubes were present |
| 7 | Armor sub-bone pivots (`rightArmArmor`, `leftArmArmor`, leggings, boots) — now use negated locator X via `ARMOR_SUBONE_LOCATOR_X` map | These bones represent the armor attachment point, not the limb joint; using the limb's live pivot gave the wrong shoulder position |
| 8 | `head` pivot override — always uses `bone.pivot` (template `[0,24,0]`) | HEAD group shifts when HEAD has a Y-offset, but the Bedrock neck-joint pivot must stay at Y=24 regardless |