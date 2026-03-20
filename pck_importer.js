(() => {
  "use strict";

  // ═══════════════════════════════════════════════════════════
  // PCK BINARY READER
  // ═══════════════════════════════════════════════════════════

  function parsePck(arrayBuffer, littleEndian) {
    const view = new DataView(arrayBuffer);
    let offset = 0;

    function readInt32() {
      const v = view.getInt32(offset, littleEndian);
      offset += 4;
      return v;
    }

    function readBytes(count) {
      const slice = new Uint8Array(arrayBuffer, offset, count);
      offset += count;
      return slice;
    }

    function readString() {
      const charCount = readInt32();
      const byteCount = charCount * 2;
      const raw = readBytes(byteCount);
      readInt32(); // discard padding
      let s = "";
      for (let i = 0; i < byteCount; i += 2) {
        const code = littleEndian ? raw[i] | (raw[i + 1] << 8) : (raw[i] << 8) | raw[i + 1];
        s += String.fromCharCode(code);
      }
      return s;
    }

    const pckType = readInt32();
    if (pckType > 0x00f00000) throw new Error("Wrong byte order.");
    if (pckType < 3) throw new Error(`Unsupported PCK type: ${pckType}`);

    const tableSize = readInt32();
    const table = new Array(tableSize).fill(null);
    for (let i = 0; i < tableSize; i++) {
      const idx = readInt32();
      table[idx] = readString();
    }
    if (table.includes("XMLVERSION")) readInt32();

    const assetCount = readInt32();
    const assets = [];
    for (let i = 0; i < assetCount; i++) {
      const dataSize = readInt32();
      const typeInt = readInt32();
      const filename = readString().replace(/\\/g, "/");
      assets.push({ filename, typeInt, dataSize, data: null, properties: [] });
    }

    for (const asset of assets) {
      const propCount = readInt32();
      for (let i = 0; i < propCount; i++) {
        const key = table[readInt32()];
        const value = readString();
        asset.properties.push({ key, value });
      }
      asset.data = readBytes(asset.dataSize).slice();
    }

    return { pckType, assets };
  }

  function parsePckAutoEndian(arrayBuffer) {
    for (const le of [true, false]) {
      try {
        const pck = parsePck(arrayBuffer, le);
        if (pck.assets.length > 0) return pck;
      } catch (_) {}
    }
    throw new Error("Could not parse PCK — file may be corrupt or unsupported.");
  }

  // ═══════════════════════════════════════════════════════════
  // GITHUB FACE FETCH
  // Pre-rendered face images are served from GitHub at:
  //   icons/{PackID}/{skinId}.png
  // PackID is read directly from the PACKID property on the '0'
  // metadata asset inside the PCK file.
  // SkinID is the numeric suffix of the PCK asset filename
  // (e.g. "dlcskin00004400.png" → "00004400").
  // If a face is found it is used; otherwise the picker falls back
  // to extractFaceDataUrl which renders from the skin texture directly.
  // ═══════════════════════════════════════════════════════════

  const GITHUB_FACES_BASE_URL = "https://raw.githubusercontent.com/BehaviorPack/PCK-Skin-Helper/main/icons";

  // Read the PackID directly from the '0' metadata asset in the parsed PCK.
  // Returns null if the asset or property is absent.
  function getPackIdFromPck(pckFile) {
    const meta = pckFile.assets.find((a) => a.filename === "0");
    if (!meta) return null;
    const prop = meta.properties.find((p) => p.key === "PACKID");
    if (!prop) return null;
    const id = parseInt(prop.value, 10);
    return isNaN(id) ? null : id;
  }

  // Extract the numeric ID from a PCK skin asset filename.
  // "dlcskin00004400.png"  →  "00004400"
  // Returns null if no numeric sequence is found.
  function skinIdFromFilename(filename) {
    const base = filename
      .split("/")
      .pop()
      .replace(/\.png$/i, "");
    const m = base.match(/(\d+)$/);
    return m ? m[1] : null;
  }

  // Attempt to fetch a pre-rendered face image from GitHub.
  // Resolves to a data URL string on success, or null on any failure.
  function fetchGithubFace(packId, skinId) {
    if (packId == null || !skinId) return Promise.resolve(null);
    const url = `${GITHUB_FACES_BASE_URL}/${packId}/${skinId}.png`;
    return fetch(url)
      .then((res) => {
        if (!res.ok) return null;
        return res.blob().then(
          (blob) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            }),
        );
      })
      .catch(() => null);
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  const SKIN_TYPE = 0;
  const CAPE_TYPE = 1;
  const LOC_TYPE = 6;

  function getProp(asset, key) {
    return asset.properties.find((p) => p.key === key)?.value ?? null;
  }

  // Parse a localisation.loc binary file and return the value of
  // IDS_DISPLAY_NAME for the best available language (en-EN preferred,
  // then en-GB, then the first language found).
  //
  // LOC binary format:
  //   int32   version
  //   int32   key count
  //   × keys: uint8 len + utf8 string
  //   then repeated blocks, each:
  //     int32   block version
  //     uint8 len + utf8 language code
  //     int32   string count
  //     × strings: uint8 len + utf8 string
  //   (strings are in the same order as keys; index 0 = IDS_DISPLAY_NAME)
  function getPackNameFromLoc(locBytes) {
    try {
      const b = locBytes;
      let o = 0;
      const ri32 = () => {
        const v = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        o += 4;
        return v;
      };
      const rs8 = () => {
        const len = b[o++];
        const s = new TextDecoder().decode(b.slice(o, o + len));
        o += len;
        return s;
      };

      ri32(); // version
      const keyCount = ri32();
      const keys = [];
      for (let i = 0; i < keyCount; i++) keys.push(rs8());

      // IDS_DISPLAY_NAME is always at index 0
      const displayNameIdx = keys.indexOf("IDS_DISPLAY_NAME");
      if (displayNameIdx === -1) return null;

      // Read all language blocks, collect candidates
      const candidates = {};
      while (o < b.length) {
        if (o + 4 > b.length) break;
        ri32(); // block version
        if (o >= b.length) break;
        const lang = rs8();
        if (o + 4 > b.length) break;
        const strCount = ri32();
        const strings = [];
        for (let i = 0; i < strCount; i++) strings.push(rs8());
        if (displayNameIdx < strings.length) {
          candidates[lang] = strings[displayNameIdx];
        }
      }

      return candidates["en-EN"] ?? candidates["en-GB"] ?? Object.values(candidates)[0] ?? null;
    } catch (_) {
      return null;
    }
  }

  function uint8ToDataUrl(bytes) {
    let b = "";
    for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
    return "data:image/png;base64," + btoa(b);
  }

  // BOX string format (from SkinBOX.cs):
  //   PART x y z w h d u v armorMaskFlags mirror scale
  //    [0][1][2][3][4][5][6][7][8]    [9]   [10]  [11]
  //
  // [9]  = armorMaskFlags (int bitmask of armor slots to hide this box with)
  // [10] = mirror (0 or 1)
  // [11] = scale / inflate (float — expands all faces outward uniformly)
  function parseBox(str) {
    const p = str.trim().split(/\s+/);
    return {
      part: p[0],
      posX: parseFloat(p[1]),
      posY: parseFloat(p[2]),
      posZ: parseFloat(p[3]),
      sizeX: parseFloat(p[4]),
      sizeY: parseFloat(p[5]),
      sizeZ: parseFloat(p[6]),
      uvX: parseInt(p[7], 10),
      uvY: parseInt(p[8], 10),
      armorMaskFlags: p[9] !== undefined ? parseInt(p[9], 10) : 0,
      mirrorUv: p[10] !== undefined ? parseInt(p[10], 10) === 1 : false,
      scale: p[11] !== undefined ? parseFloat(p[11]) : 0,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BONE DEFINITIONS - copied exactly from PCK Skin Helper
  // ═══════════════════════════════════════════════════════════

  const BONE_BB_PIVOT = {
    HEAD: [0, 24, 0],
    BODY: [0, 24, 0],
    ARM0: [6, 22, 0],
    ARM1: [-6, 22, 0],
    LEG0: [2, 12, 0],
    LEG1: [-2, 12, 0],
  };

  // Armor locator definitions — copied exactly from PCK Skin Helper.
  // Each locator sits at its default world-space position inside its parent bone.
  const ARMOR_LOCATORS = [
    { name: "HELMET", parentBone: "HEAD", defaultPos: [0, 24, 0] },
    { name: "CHEST", parentBone: "BODY", defaultPos: [0, 24, 0] },
    { name: "SHOULDER0", parentBone: "ARM0", defaultPos: [6, 22, 0] },
    { name: "SHOULDER1", parentBone: "ARM1", defaultPos: [-6, 22, 0] },
    { name: "PANTS0", parentBone: "LEG0", defaultPos: [2, 12, 0] },
    { name: "PANTS1", parentBone: "LEG1", defaultPos: [-2, 12, 0] },
    { name: "BOOT0", parentBone: "LEG0", defaultPos: [2, 12, 0] },
    { name: "BOOT1", parentBone: "LEG1", defaultPos: [-2, 12, 0] },
  ];

  // UUID prefix matching PCK Skin Helper so locators are recognised as armor locators.
  const ARMOR_LOCATOR_UUID_PREFIX = "llllllll";

  // Build armor locators, but only for entries that are actually used by this skin.
  // A locator is "used" if:
  //   - it has an explicit OFFSET entry in the skin (its position differs from default), OR
  //   - its parent bone has an OFFSET entry (the locator must move with it).
  // Locators that sit at their exact default position with no bone shift are unused
  // and must be omitted — they would otherwise appear as redundant entries in the PSM export.
  function buildArmorLocators(boneMap, usedLocatorNames, offsetBoneNames) {
    ARMOR_LOCATORS.forEach((def) => {
      const bone = boneMap[def.parentBone];
      if (!bone) return;
      // Skip if neither the locator nor its parent bone has any offset
      if (!usedLocatorNames.has(def.name) && !offsetBoneNames.has(def.parentBone)) return;
      const uuid = ARMOR_LOCATOR_UUID_PREFIX + guid().substr(8);
      new Locator({ name: def.name, position: def.defaultPos.slice() }, uuid).addTo(bone).init();
    });
  }

  const BONE_TRANSLATION = {
    HEAD: [0, 0, 0],
    BODY: [0, 0, 0],
    ARM0: [-5, 2, 0],
    ARM1: [5, 2, 0],
    LEG0: [-2, 12, 0],
    LEG1: [2, 12, 0],
  };

  // ═══════════════════════════════════════════════════════════
  // BOX → Blockbench cube
  //
  // From the PSM plugin export transform (SkinModelImporter.cs):
  //   posX = -bbFrom.X - sizeX - t.X
  //   posY = -bbFrom.Y - sizeY + 24 - t.Y
  //   posZ =  bbFrom.Z - t.Z
  //
  // Solving for bbFrom (import direction):
  //   fromX = -posX - sizeX - t.X
  //   fromY = -posY - sizeY + 24 - t.Y
  //   fromZ =  posZ + t.Z
  // ═══════════════════════════════════════════════════════════

  function boxToBBCube(box, yOffset) {
    const t = BONE_TRANSLATION[box.part] || [0, 0, 0];
    const fromX = -box.posX - box.sizeX - t[0];
    // Subtract yOffset so cubes stay at the correct world position when the
    // bone pivot has been shifted by an OFFSET property — same as PSM plugin.
    const fromY = -box.posY - box.sizeY + 24 - t[1] - (yOffset || 0);
    const fromZ = box.posZ + t[2];
    return {
      from: [fromX, fromY, fromZ],
      to: [fromX + box.sizeX, fromY + box.sizeY, fromZ + box.sizeZ],
      uv: [box.uvX, box.uvY],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 64x32 BOTTOM FACE FLIP
  //
  // In a 64x32 skin the bottom faces of each standard body part
  // are stored flipped vertically relative to what Blockbench
  // expects. We fix this by editing the raw pixel data of the
  // texture directly — flipping each bottom-face region in-place
  // before handing the image to Blockbench.
  //
  // Regions to flip (x1, y1, x2, y2) — all in pixel coords:
  //   HEAD bottom:     [16,  0, 24,  8]
  //   HEADWEAR bottom: [48,  0, 56,  8]
  //   BODY bottom:     [28, 16, 36, 20]
  //   ARM bottom:      [48, 16, 52, 20]  (shared by ARM0 & ARM1)
  //   LEG bottom:      [ 8, 16, 12, 20]  (shared by LEG0 & LEG1)
  // ═══════════════════════════════════════════════════════════

  // Flip a rectangular region of an ImageData vertically in-place.
  function flipRegionV(imageData, x1, y1, x2, y2) {
    const w = imageData.width;
    const d = imageData.data;
    const regionW = x2 - x1;
    const regionH = y2 - y1;
    for (let row = 0; row < Math.floor(regionH / 2); row++) {
      const topY = y1 + row;
      const bottomY = y2 - 1 - row;
      for (let col = 0; col < regionW; col++) {
        const topIdx = (topY * w + x1 + col) * 4;
        const bottomIdx = (bottomY * w + x1 + col) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const tmp = d[topIdx + ch];
          d[topIdx + ch] = d[bottomIdx + ch];
          d[bottomIdx + ch] = tmp;
        }
      }
    }
  }

  // ANIM flag masks for each body part (from PCK Skin Helper)
  const ANIM_HEAD_DISABLED = 0x400;
  const ANIM_HEADWEAR_DISABLED = 0x10000;
  const ANIM_BODY_DISABLED = 0x2000;
  const ANIM_ARM0_DISABLED = 0x800;
  const ANIM_ARM1_DISABLED = 0x1000;
  const ANIM_LEG0_DISABLED = 0x4000;
  const ANIM_LEG1_DISABLED = 0x8000;

  // Build the list of 64x32 bottom-face regions to flip, skipping any
  // part that is disabled in the skin's ANIM flags (those texture regions
  // are unused, so flipping them would corrupt the texture for no benefit).
  //
  // ARM and LEG regions are shared between both sides — only skip if
  // BOTH sides are disabled (otherwise the shared region is still in use).
  function getBottomFaceRegions(animFlags) {
    const regions = [];
    if (!(animFlags & ANIM_HEAD_DISABLED)) regions.push([16, 0, 24, 8]); // HEAD bottom
    if (!(animFlags & ANIM_HEADWEAR_DISABLED)) regions.push([48, 0, 56, 8]); // HEADWEAR bottom
    // if (!(animFlags & ANIM_BODY_DISABLED))                                    regions.push([28, 16, 36, 20]); // BODY bottom
    // if (!((animFlags & ANIM_ARM0_DISABLED) && (animFlags & ANIM_ARM1_DISABLED))) regions.push([48, 16, 52, 20]); // ARM bottom
    // if (!((animFlags & ANIM_LEG0_DISABLED) && (animFlags & ANIM_LEG1_DISABLED))) regions.push([ 8, 16, 12, 20]); // LEG bottom
    return regions;
  }

  // Decode a PNG Uint8Array, flip only the active 64x32 bottom face regions,
  // and return a corrected data URL. Uses an offscreen canvas.
  function fix64x32BottomFaces(pngBytes, animFlags) {
    return new Promise((resolve) => {
      const regions = getBottomFaceRegions(animFlags);
      if (regions.length === 0) {
        // Nothing to flip — return the original texture as-is
        resolve(uint8ToDataUrl(pngBytes));
        return;
      }
      const dataUrl = uint8ToDataUrl(pngBytes);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (const [x1, y1, x2, y2] of regions) {
          flipRegionV(imageData, x1, y1, x2, y2);
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = dataUrl;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MODEL BUILDER
  // ═══════════════════════════════════════════════════════════

  async function buildModel(skinAsset, pckFile) {
    if (!Formats.pck_skin) {
      Blockbench.showMessageBox({
        title: "PCK Skin Helper Required",
        message:
          "Please install the <b>PCK Skin Helper</b> plugin first.\n" +
          "It provides the pck_skin format that this importer depends on.",
        icon: "error",
      });
      return;
    }

    const skinName = getProp(skinAsset, "DISPLAYNAME") ?? skinAsset.filename.replace(/\.png$/i, "");

    // ── Derive ANIM flags ────────────────────────────────────
    // If the skin has an ANIM property, it is a hex string that IS
    // the psm_anim_flags value directly (e.g. "1C0400"), stored by
    // PCK Studio via SkinANIM.ToString(). Parse it straight in.
    //
    // If there is NO ANIM property the skin uses the classic 64×32
    // layout with no special flags — all checkboxes stay unchecked.
    const animPropRaw = getProp(skinAsset, "ANIM");
    let animFlags = 0; // default: all unchecked (64×32 classic)
    if (animPropRaw !== null) {
      const parsed = parseInt(animPropRaw, 16);
      if (!isNaN(parsed)) animFlags = parsed;
    }

    // RESOLUTION_64x64 (0x40000) or SLIM_MODEL (0x80000) both mean 64×64 UV.
    // No ANIM property at all (animFlags = 0) means classic 64×32.
    const uvHeight = animFlags & (0x40000 | 0x80000) ? 64 : 32;

    // Pre-process the skin texture before opening the project.
    // For 64x32 skins, flip the bottom face regions now so the corrected
    // data URL is ready to hand straight to Texture.fromDataURL below.
    // Doing this before newProject avoids any async yield inside an active project.
    const skinDataUrl =
      uvHeight === 32 ? await fix64x32BottomFaces(skinAsset.data, animFlags) : uint8ToDataUrl(skinAsset.data);

    if (!newProject(Formats.pck_skin)) return;
    Project.name = skinName;
    Project.pck_skin_uuid = guid();
    Project.pck_skin_id = skinIdFromFilename(skinAsset.filename) || null;
    Project.psm_anim_flags = animFlags;
    Project.texture_width = 64;
    Project.texture_height = uvHeight;

    // Build the skeleton structure matching PCK Skin Helper exactly
    const rootGroup = new Group({ name: "ROOT", origin: [0, 0, 0] }).init();
    rootGroup.export = false;
    const waistGroup = new Group({ name: "WAIST", origin: [0, 12, 0] }).addTo(rootGroup).init();
    waistGroup.export = false;

    const WAIST_BONES = new Set(["HEAD", "BODY", "ARM0", "ARM1"]);
    const boneMap = {};
    for (const [name, pivot] of Object.entries(BONE_BB_PIVOT)) {
      const g = new Group({ name, origin: pivot });
      g.addTo(WAIST_BONES.has(name) ? waistGroup : rootGroup);
      boneMap[name] = g.init();
    }

    // Determine which armor locators and bones actually have OFFSET entries
    // in this skin, so we only create the locators that are genuinely used.
    // A locator at its default position with no bone shift is meaningless and
    // would pollute the PSM export with unused offset/locator entries.
    const usedLocatorNames = new Set();
    const offsetBoneNames = new Set();
    for (const prop of skinAsset.properties.filter((p) => p.key === "OFFSET")) {
      const typeName = (prop.value ?? "").trim().split(/\s+/)[0];
      if (ARMOR_LOCATORS.some((l) => l.name === typeName)) {
        usedLocatorNames.add(typeName);
      } else if (typeName in BONE_BB_PIVOT || typeName === "WAIST") {
        offsetBoneNames.add(typeName);
      }
    }

    // Build armor locators — only for those that are offset or whose parent bone is offset.
    buildArmorLocators(boneMap, usedLocatorNames, offsetBoneNames);

    // Build offsetMapY: per-bone Y offset values, used both to shift bone pivots
    // and to counteract those shifts in BOX cube world positions.
    //
    // IMPORTANT: WAIST offset is NOT propagated into its children here.
    // The WAIST group pivot encodes the WAIST offset directly (origin.Y = 12 + waistVal).
    // Child bones (HEAD/BODY/ARM0/ARM1) each carry only their own offset.
    // This matches psmToModel in pck_skin_helper exactly.
    const offsetMapY = {};
    let waistOffsetVal = 0;
    for (const prop of skinAsset.properties.filter((p) => p.key === "OFFSET")) {
      const parts = (prop.value ?? "").trim().split(/\s+/);
      if (parts.length < 3 || parts[1] !== "Y") continue;
      const boneName = parts[0];
      const val = parseFloat(parts[2]);
      if (isNaN(val)) continue;
      if (boneName === "WAIST") {
        waistOffsetVal = val;
      } else if (boneName in BONE_BB_PIVOT) {
        offsetMapY[boneName] = (offsetMapY[boneName] || 0) + val;
      }
    }

    // Apply OFFSET properties to bone pivots and armor locators.
    //
    // Bone pivot formula (matches psmToModel):
    //   WAIST: origin.Y = 12 + waistOffsetVal   (adds, mirrors psmToModel)
    //   Others: origin[axis] = default[axis] - value
    //
    // Locator offset formula:
    //   locator.position[axis] = defaultPos[axis] - value
    //
    // LOCATOR types: HELMET, CHEST, SHOULDER0/1, PANTS0/1, BOOT0/1, TOOL0/1

    const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

    // Apply WAIST pivot offset
    if (waistOffsetVal !== 0) {
      waistGroup.origin[1] = 12 + waistOffsetVal;
      if (waistGroup.updateElement) waistGroup.updateElement();
    }

    for (const prop of skinAsset.properties.filter((p) => p.key === "OFFSET")) {
      const raw = prop.value ?? "";
      const parts = raw.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const [typeName, axis, rawVal] = parts;
      const axisIdx = AXIS_INDEX[axis.toUpperCase()];
      if (axisIdx === undefined) continue;
      const value = parseFloat(rawVal);
      if (isNaN(value)) continue;

      // ── Root bone pivot offset (not WAIST — handled above) ──
      if (typeName !== "WAIST" && BONE_BB_PIVOT[typeName]) {
        const defaultPos = BONE_BB_PIVOT[typeName];
        const group = boneMap[typeName];
        if (!group) continue;
        group.origin[0] = defaultPos[0];
        group.origin[1] = defaultPos[1];
        group.origin[2] = defaultPos[2];
        group.origin[axisIdx] = defaultPos[axisIdx] - value;
        if (group.updateElement) group.updateElement();
        continue;
      }

      // ── Armor locator offset ───────────────────────────────
      // The offset value is relative to the parent bone's CURRENT pivot, not its
      // default world-space position.  When the parent bone has its own Y offset
      // (e.g. HEAD Y 13 moves the pivot from 24 to 11), the locator must start
      // from that shifted pivot before applying its own offset.
      // Formula: locator.position[axis] = (defaultPos[axis] - parentBoneOffset[axis]) - value
      const locDef = ARMOR_LOCATORS.find((l) => l.name === typeName);
      if (!locDef) continue;
      const loc = Locator.all.find(
        (l) => l.name === typeName && typeof l.uuid === "string" && l.uuid.startsWith(ARMOR_LOCATOR_UUID_PREFIX),
      );
      if (!loc) continue;
      const parentBoneOffsetY = offsetMapY[locDef.parentBone] || 0;
      loc.position[0] = locDef.defaultPos[0];
      loc.position[1] = locDef.defaultPos[1] - parentBoneOffsetY;
      loc.position[2] = locDef.defaultPos[2];
      // For Y axis: already accounts for parent bone offset above.
      // For X/Z axes: parent bone offsets are not tracked (only Y is used), so apply directly.
      if (axisIdx === 1) {
        loc.position[1] -= value;
      } else {
        loc.position[axisIdx] = locDef.defaultPos[axisIdx] - value;
      }
      if (loc.updateElement) loc.updateElement();
    }

    Canvas.updateAll();

    // Propagate parent bone Y offsets into child armor locators.
    // When a bone pivot shifts (e.g. HEAD Y 2 → pivot 24→22), the locators
    // parented to it must shift by the same amount so armor preview stays
    // correctly positioned. Formula mirrors psmToModel:
    //   loc.position[1] = defaultPos[1] - parentOffsetY
    // Skip any locator that was already explicitly positioned above by a
    // direct PCK OFFSET entry for that locator name.
    const explicitLocatorNames = new Set();
    for (const prop of skinAsset.properties.filter((p) => p.key === "OFFSET")) {
      const parts = (prop.value ?? "").trim().split(/\s+/);
      if (parts.length >= 1) explicitLocatorNames.add(parts[0]);
    }
    for (const locDef of ARMOR_LOCATORS) {
      if (explicitLocatorNames.has(locDef.name)) continue;
      const parentOffsetY = offsetMapY[locDef.parentBone] || 0;
      if (parentOffsetY === 0) continue;
      const loc = Locator.all.find(
        (l) => l.name === locDef.name && typeof l.uuid === "string" && l.uuid.startsWith(ARMOR_LOCATOR_UUID_PREFIX),
      );
      if (!loc) continue;
      loc.position[1] = locDef.defaultPos[1] - parentOffsetY;
      if (loc.updateElement) loc.updateElement();
    }

    // Skin texture (slot 0)
    new Texture({ name: skinName + ".png" }).fromDataURL(skinDataUrl).add(false);

    // Cape texture (slot 1) if referenced
    const capePath = getProp(skinAsset, "CAPEPATH");
    if (capePath) {
      const capeAsset = pckFile.assets.find((a) => a.typeInt === CAPE_TYPE && a.filename === capePath);
      if (capeAsset) {
        new Texture({ name: "cape.png" }).fromDataURL(uint8ToDataUrl(capeAsset.data)).add(false);
      }
    }

    // BOX cubes
    const boxProps = skinAsset.properties.filter((p) => p.key === "BOX");
    if (boxProps.length > 0) {
      Undo.initEdit({ elements: [], outliner: true });
      for (const prop of boxProps) {
        const box = parseBox(prop.value);
        const bone = boneMap[box.part];
        if (!bone) continue;
        const yOffset = offsetMapY[box.part] || 0;
        const { from, to, uv } = boxToBBCube(box, yOffset);
        const armorMask = box.armorMaskFlags || 0;
        const cube = new Cube({
          name: box.part,
          from,
          to,
          uv_offset: uv,
          box_uv: true,
          inflate: box.scale || 0,
          mirror_uv: box.mirrorUv || false,
        });
        cube.psm_imported = true;
        cube.pck_armor_mask = armorMask;
        // psm_hide_with_armor is what modelToPSM reads on export — keep both in sync.
        cube.psm_hide_with_armor = armorMask !== 0;
        cube.addTo(bone).init();
      }
      Undo.finishEdit("Import PCK BOX cubes");
    }

    // Sync ANIM flags panel
    const animPanel = Interface.Panels.pck_anim;
    if (animPanel?.inside_vue) {
      animPanel.inside_vue.anim_flags = animFlags;
    }

    Canvas.updateAll();
    Blockbench.showQuickMessage(`Loaded: ${skinName}`, 2000);
  }

  // ═══════════════════════════════════════════════════════════
  // SKIN PICKER DIALOG
  // ═══════════════════════════════════════════════════════════

  // Extract the front face of the head (UV 8,8 → 16,16) from raw PNG bytes,
  // scale it up to 32×32 with nearest-neighbour, and return a data URL.
  // Returns null if the canvas operations fail for any reason.
  function extractFaceDataUrl(pngBytes) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          // Source: 8×8 face region at pixel (8,8)
          const srcCanvas = document.createElement("canvas");
          srcCanvas.width = img.width;
          srcCanvas.height = img.height;
          const srcCtx = srcCanvas.getContext("2d");
          srcCtx.drawImage(img, 0, 0);

          // Destination: 32×32 scaled up with nearest-neighbour (crisp pixels)
          const dstCanvas = document.createElement("canvas");
          dstCanvas.width = 32;
          dstCanvas.height = 32;
          const dstCtx = dstCanvas.getContext("2d");
          dstCtx.imageSmoothingEnabled = false;
          dstCtx.drawImage(srcCanvas, 8, 8, 8, 8, 0, 0, 32, 32);
          resolve(dstCanvas.toDataURL("image/png"));
        } catch (_) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = uint8ToDataUrl(pngBytes);
    });
  }

  async function showSkinPicker(pckFile, fileName) {
    const skins = pckFile.assets.filter((a) => a.typeInt === SKIN_TYPE);

    if (skins.length === 0) {
      Blockbench.showMessageBox({
        title: "No Skins Found",
        message: "This PCK file contains no skin assets.",
        icon: "error",
      });
      return;
    }

    if (skins.length === 1) {
      buildModel(skins[0], pckFile);
      return;
    }

    // Try to get the pack's display name from IDS_DISPLAY_NAME in the loc file.
    // Fall back to the filename if no loc file or no name found.
    const locAsset = pckFile.assets.find((a) => a.typeInt === LOC_TYPE);
    const packName = (locAsset ? getPackNameFromLoc(locAsset.data) : null) ?? fileName;

    // Build skin entries with display name and face icon data URL.
    // For each skin: try to fetch a pre-rendered face from GitHub first
    // (icons/{PackID}/{skinId}.png), falling back to extractFaceDataUrl
    // which renders the face region from the skin texture directly.
    // PackID is read directly from the PACKID property on the '0' asset.
    const packId = getPackIdFromPck(pckFile);
    const skinEntries = await Promise.all(
      skins.map(async (skin) => {
        const name = getProp(skin, "DISPLAYNAME") ?? skin.filename.replace(/\.png$/i, "");
        const theme = getProp(skin, "THEMENAME");
        const label = theme ? `${name}  (${theme})` : name;

        const skinId = skinIdFromFilename(skin.filename);
        const githubFace = await fetchGithubFace(packId, skinId);
        const faceUrl = githubFace ?? (await extractFaceDataUrl(skin.data));

        return { label, faceUrl };
      }),
    );

    new Dialog({
      id: "pck_skin_picker",
      title: "Choose a Skin",
      width: 460,
      component: {
        data() {
          return {
            selected: 0,
            entries: skinEntries,
            packName,
          };
        },
        methods: {
          confirm() {
            this.$emit("confirm");
          },
        },
        template: `
          <div>
            <p style="margin:0 0 8px 0;opacity:0.7;">Found {{ entries.length }} skins in {{ packName }}.</p>
            <div style="
              max-height: 320px;
              overflow-y: auto;
              border: 1px solid var(--color-border);
              border-radius: 4px;
            ">
              <div
                v-for="(entry, i) in entries"
                :key="i"
                @click="selected = i"
                @dblclick="selected = i; confirm()"
                :style="{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  background: selected === i ? 'var(--color-accent)' : 'transparent',
                  color: selected === i ? 'var(--color-light)' : 'var(--color-text)',
                }"
              >
                <img
                  v-if="entry.faceUrl"
                  :src="entry.faceUrl"
                  width="32"
                  height="32"
                  style="image-rendering:pixelated;flex-shrink:0;border-radius:2px;"
                />
                <div
                  v-else
                  style="width:32px;height:32px;flex-shrink:0;background:var(--color-border);border-radius:2px;"
                ></div>
                <span style="font-size:13px;">{{ entry.label }}</span>
              </div>
            </div>
          </div>
        `,
      },
      onConfirm() {
        const idx = this.content_vue ? this.content_vue.selected : 0;
        buildModel(skins[idx], pckFile);
      },
    }).show();
  }

  // ═══════════════════════════════════════════════════════════
  // SHARED IMPORT TRIGGER
  // Called from both the start screen loader and the menu action
  // ═══════════════════════════════════════════════════════════

  function triggerImport() {
    Blockbench.import(
      {
        resource_id: "pck_skin_file",
        extensions: ["pck"],
        type: "Skin PCK",
        readtype: "buffer",
        multiple: false,
      },
      (files) => {
        if (!files?.length) return;
        try {
          const name = files[0].name.replace(/\.pck$/i, "");
          showSkinPicker(parsePckAutoEndian(files[0].content), name);
        } catch (err) {
          Blockbench.showMessageBox({
            title: "Skin PCK Import Failed",
            message: err.message,
            icon: "error",
          });
        }
      },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // PLUGIN REGISTRATION
  // ═══════════════════════════════════════════════════════════

  Plugin.register("pck_importer", {
    title: "Import Skin PCK",
    author: "BehaviorPack",
    icon: "icon-bb_interface",
    description: "Import Minecraft Legacy Edition skin .pck files. Requires PCK Skin Helper.",
    version: "1.0.1",
    min_version: "4.0.0",
    creation_date: "2026-03-15",
    variant: "both",
    await_loading: true,

    onload() {
      // ── Armor mask visibility patch ──────────────────────────
      // When the PCK Skin Helper's armor preview is active, hide any
      // imported BOX cubes whose pck_armor_mask flags match the currently
      // equipped armor pieces.
      //
      // ArmorMaskFlags bits (from SkinBOX.cs):
      //   1 = hide with helmet
      //   2 = hide with chestplate
      //   4 = hide with leggings
      //   8 = hide with boots
      //
      // We detect which armor is active by reading Project.pck_armor_cubes
      // (populated by the PSM helper's rebuildArmorCubes) and matching names.
      // Canvas.updateAllUVs is called at the end of rebuildArmorCubes — we
      // patch it to apply visibility after every armor rebuild.

      const PCK_ARMOR_MASK = { HELMET: 1, CHESTPLATE: 2, LEGGINGS: 4, BOOTS: 8 };

      function getActiveMask() {
        let mask = 0;
        const ac = (Project && Project.pck_armor_cubes) || [];
        for (const c of ac) {
          const n = c.name || "";
          if (n === "armorHelmet") mask |= PCK_ARMOR_MASK.HELMET;
          if (n === "armorBody" || n === "armorRightArm" || n === "armorLeftArm") mask |= PCK_ARMOR_MASK.CHESTPLATE;
          if (n === "armorLegsBody" || n === "armorRightLeg" || n === "armorLeftLeg") mask |= PCK_ARMOR_MASK.LEGGINGS;
          if (n === "rightBoot" || n === "leftBoot") mask |= PCK_ARMOR_MASK.BOOTS;
        }
        return mask;
      }

      function applyArmorMaskVisibility() {
        if (!Format || Format.id !== "pck_skin") return;
        const activeMask = getActiveMask();
        for (const cube of Cube.all) {
          if (!cube.pck_armor_mask) continue;
          const shouldHide = (cube.pck_armor_mask & activeMask) !== 0;
          if (cube.mesh) cube.mesh.visible = !shouldHide;
        }
      }

      this._origUpdateAllUVs = Canvas.updateAllUVs;
      Canvas.updateAllUVs = (...args) => {
        this._origUpdateAllUVs.apply(Canvas, args);
        applyArmorMaskVisibility();
      };

      // ── Start screen loader ──────────────────────────────────
      this._loader = new ModelLoader("import_skin_pck", {
        name: "Import Skin PCK",
        description: "Import a Skins.pck file from Console Legacy.",
        tags: ["Minecraft: Legacy Console Edition", "PCK"],
        icon: "icon-bb_interface",
        onStart: triggerImport,
        format_page: {
          component: {
            methods: { triggerImport },
            template: `
              <div style="display:flex;flex-direction:column;height:100%">
                <p class="format_description">Import a Minecraft Legacy Edition skin .pck file into Blockbench.</p>
                <p class="format_target">
                  <b>Target</b> : <span>Minecraft: Legacy Console Edition</span>
                </p>
                <content class="markdown">
                  <h3><p>Good to know:</p></h3>
                  <p><ul>
                    <li><p>Requires the <strong>PCK Skin Helper</strong> plugin to be installed.</p></li>
                    <li><p>Skins.pck files can be opened from all console versions of the game.</p></li>
                  </ul></p>
                </content>
                <div class="button_bar">
                  <button id="create_new_model_button" @click="triggerImport()">
                    <i class="material-icons">arrow_forward</i> Open Skin PCK
                  </button>
                </div>
              </div>
            `,
          },
        },
      });

      // ── Drag-and-drop ────────────────────────────────────────
      this._dragHandler = Blockbench.addDragHandler("pck_skin_drag", { extensions: ["pck"], type: "text" }, (file) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const name = file.name.replace(/\.pck$/i, "");
            showSkinPicker(parsePckAutoEndian(e.target.result), name);
          } catch (err) {
            Blockbench.showMessageBox({
              title: "Skin PCK Import Failed",
              message: err.message,
              icon: "error",
            });
          }
        };
        reader.readAsArrayBuffer(file);
      });

      // ── File → Import menu item ──────────────────────────────
      this._importAction = new Action("import_skin_pck", {
        name: "Import Skin PCK",
        icon: "icon-bb_interface",
        click: triggerImport,
      });

      MenuBar.addAction(this._importAction, "file.import");
    },

    onunload() {
      if (this._loader) this._loader.delete();
      if (this._dragHandler) Blockbench.removeDragHandler("pck_skin_drag");
      if (this._importAction) this._importAction.delete();
      if (this._origUpdateAllUVs) Canvas.updateAllUVs = this._origUpdateAllUVs;
    },
  });
})();
