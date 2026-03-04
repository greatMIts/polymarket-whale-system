/**
 * settings.ts — Single Source of Truth for bot settings.
 *
 * Layer 2b — Imports types, config, clob.
 * get() is the ONLY way any module reads settings.
 * update() is the ONLY way settings change.
 * Boot always starts in PAPER.
 */

import * as fs from 'fs';
import { BotSettings, FilterPresetName, MidEdgeRange } from './types';
import { BOT_ID, CONFIG } from './config';
import { isClobReady } from './clob';

// ── The one and only settings object ──
let currentSettings: BotSettings;

// ── Callback (injected by index.ts) ──
type OnChangedFn = () => void;
let onChangedCallback: OnChangedFn | null = null;
export function setOnChanged(fn: OnChangedFn) { onChangedCallback = fn; }

// ── First-Boot Defaults ──
const FIRST_BOOT: Record<FilterPresetName, BotSettings> = {
  BALANCED: {
    mode: "PAPER",
    botEnabled: true,
    takeProfitEnabled: true,
    takeProfitPrice: 0.92,
    standardSize: 18,
    highConvictionSize: 18,
    highConvictionThreshold: 0.80,
    maxOpenPositions: 10,
    maxExposureUSD: 200,
    maxLossPerHour: 50,
    maxLossPerSession: 100,
    cooldownMs: 5000,
    maxEntriesPerContract: 1,
    minStackSize: 25,
    priceFloor: 0.52,
    priceCeiling: 0.77,
    midEdgeRanges: [{ operator: "lt", value: -0.1 }],
    edgeVsSpotEnabled: true,
    edgeVsSpotThreshold: 0.0,
    edgeVsSpotCeiling: 0,
    momentumRequired: false,
    whaleSizeGate: 0,
    secsRanges5m: [[90, 120], [150, 180], [210, 300]],
    secsRanges15m: [[90, 120], [150, 180], [210, 300]],
    inactiveHoursUTC: [0, 0],
    allowedAssets: ["BTC", "ETH"],
    allowedSides: ["BUY"],
    enabledWallets: ["0x63ce", "0x37c9", "0x0ea5", "0x1d00", "0x1979", "0x571c", "0x2d8b"],
  },

  GOLD_PLUS: {
    mode: "PAPER",
    botEnabled: true,
    takeProfitEnabled: true,
    takeProfitPrice: 0.92,
    standardSize: 18,
    highConvictionSize: 18,
    highConvictionThreshold: 1.0,
    maxOpenPositions: 15,
    maxExposureUSD: 300,
    maxLossPerHour: 250,
    maxLossPerSession: 500,
    cooldownMs: 5000,
    maxEntriesPerContract: 1,
    minStackSize: 25,
    priceFloor: 0.52,
    priceCeiling: 0.73,
    midEdgeRanges: [{ operator: "lt", value: -0.05 }],
    edgeVsSpotEnabled: true,
    edgeVsSpotThreshold: 0.0,
    edgeVsSpotCeiling: 0,
    momentumRequired: false,
    whaleSizeGate: 0,
    secsRanges5m: [[90, 120], [150, 180], [210, 300]],
    secsRanges15m: [[90, 120], [150, 180], [210, 300]],
    inactiveHoursUTC: [0, 0],
    allowedAssets: ["BTC", "ETH"],
    allowedSides: ["BUY"],
    enabledWallets: ["0x63ce", "0x37c9", "0x0ea5", "0x1d00", "0x1979", "0x571c", "0xf696", "0x2d8b"],
  },

  NEW_BEST: {
    mode: "PAPER",
    botEnabled: true,
    takeProfitEnabled: true,
    takeProfitPrice: 0.92,
    standardSize: 18,
    highConvictionSize: 18,
    highConvictionThreshold: 1.0,
    maxOpenPositions: 15,
    maxExposureUSD: 300,
    maxLossPerHour: 100,
    maxLossPerSession: 200,
    cooldownMs: 5000,
    maxEntriesPerContract: 1,
    minStackSize: 25,
    priceFloor: 0.52,
    priceCeiling: 0.73,
    midEdgeRanges: [{ operator: "lt", value: -0.05 }],
    edgeVsSpotEnabled: true,
    edgeVsSpotThreshold: 0.0,
    edgeVsSpotCeiling: 0,
    momentumRequired: false,
    whaleSizeGate: 0,
    secsRanges5m: [[90, 120], [150, 180], [210, 300]],
    secsRanges15m: [[90, 120], [150, 180], [210, 300]],
    inactiveHoursUTC: [0, 0],
    allowedAssets: ["BTC", "ETH"],
    allowedSides: ["BUY"],
    enabledWallets: ["0x63ce", "0x37c9", "0x0ea5", "0x1d00", "0x1979", "0x571c", "0xf696", "0x2d8b"],
  },
};

export function loadFromDisk(): void {
  const fromFile = readFromFile();
  currentSettings = fromFile ?? FIRST_BOOT[BOT_ID];
  console.log(`[settings] Loaded for ${BOT_ID}: mode=${currentSettings.mode}, ${currentSettings.enabledWallets.length} wallets`);
}

export function get(): Readonly<BotSettings> {
  return currentSettings;
}

export function getDefaults(): Readonly<BotSettings> {
  return FIRST_BOOT[BOT_ID];
}

export function update(partial: Partial<BotSettings>): { rejected?: string } {
  // Validate bounds
  if (partial.standardSize !== undefined && partial.standardSize < 1)
    return { rejected: 'standardSize must be >= 1' };
  if (partial.highConvictionSize !== undefined && partial.highConvictionSize < 1)
    return { rejected: 'highConvictionSize must be >= 1' };
  if (partial.maxOpenPositions !== undefined && partial.maxOpenPositions < 1)
    return { rejected: 'maxOpenPositions must be >= 1' };
  if (partial.maxExposureUSD !== undefined && partial.maxExposureUSD < 10)
    return { rejected: 'maxExposureUSD must be >= 10' };
  if (partial.maxLossPerHour !== undefined && partial.maxLossPerHour < 5)
    return { rejected: 'maxLossPerHour must be >= 5' };
  if (partial.maxLossPerSession !== undefined && partial.maxLossPerSession < 10)
    return { rejected: 'maxLossPerSession must be >= 10' };
  if (partial.cooldownMs !== undefined && partial.cooldownMs < 0)
    return { rejected: 'cooldownMs must be >= 0' };
  if (partial.maxEntriesPerContract !== undefined && partial.maxEntriesPerContract < 1)
    return { rejected: 'maxEntriesPerContract must be >= 1' };
  if (partial.minStackSize !== undefined && partial.minStackSize < 0)
    return { rejected: 'minStackSize must be >= 0' };
  if (partial.whaleSizeGate !== undefined && partial.whaleSizeGate < 0)
    return { rejected: 'whaleSizeGate must be >= 0' };

  // Price floor/ceiling validation
  const newFloor = partial.priceFloor ?? currentSettings.priceFloor;
  const newCeiling = partial.priceCeiling ?? currentSettings.priceCeiling;
  if (partial.priceFloor !== undefined && (partial.priceFloor < 0.01 || partial.priceFloor > 0.99))
    return { rejected: 'priceFloor must be in [0.01, 0.99]' };
  if (partial.priceCeiling !== undefined && (partial.priceCeiling < 0.01 || partial.priceCeiling > 1.0))
    return { rejected: 'priceCeiling must be in [0.01, 1.0]' };
  if (newCeiling < newFloor)
    return { rejected: 'priceCeiling must be >= priceFloor' };

  if (partial.takeProfitPrice !== undefined && (partial.takeProfitPrice < 0.50 || partial.takeProfitPrice > 1.0))
    return { rejected: 'takeProfitPrice must be in [0.50, 1.0]' };
  if (partial.edgeVsSpotCeiling !== undefined && partial.edgeVsSpotCeiling < 0)
    return { rejected: 'edgeVsSpotCeiling must be >= 0' };
  if (partial.highConvictionThreshold !== undefined && (partial.highConvictionThreshold < 0.50 || partial.highConvictionThreshold > 1.0))
    return { rejected: 'highConvictionThreshold must be in [0.50, 1.0]' };

  // secsRanges validation
  if (partial.secsRanges5m !== undefined) {
    for (const [a, b] of partial.secsRanges5m) {
      if (a <= 0 || b <= 0 || a >= b || b > 300)
        return { rejected: 'secsRanges5m: each pair [a, b] requires 0 < a < b <= 300' };
    }
  }
  if (partial.secsRanges15m !== undefined) {
    for (const [a, b] of partial.secsRanges15m) {
      if (a <= 0 || b <= 0 || a >= b || b > 900)
        return { rejected: 'secsRanges15m: each pair [a, b] requires 0 < a < b <= 900' };
    }
  }

  // Array validations
  if (partial.allowedAssets !== undefined && partial.allowedAssets.length === 0)
    return { rejected: 'allowedAssets must have at least one asset' };
  if (partial.allowedSides !== undefined && partial.allowedSides.length === 0)
    return { rejected: 'allowedSides must have at least one side' };
  if (partial.enabledWallets !== undefined && partial.enabledWallets.length === 0)
    return { rejected: 'enabledWallets must have at least one wallet' };

  // Inactive hours validation
  if (partial.inactiveHoursUTC !== undefined) {
    const [s, e] = partial.inactiveHoursUTC;
    if (s < 0 || s > 23 || e < 0 || e > 23)
      return { rejected: 'inactiveHoursUTC: start and end must be in [0, 23]' };
  }

  // LIVE mode switch check
  if (partial.mode === 'LIVE' && currentSettings.mode !== 'LIVE') {
    if (!isClobReady()) {
      return { rejected: 'CLOB not connected — cannot switch to LIVE' };
    }
  }

  // Merge
  currentSettings = { ...currentSettings, ...partial };

  // Advisory: priceCeiling >= takeProfitPrice
  if (currentSettings.priceCeiling >= currentSettings.takeProfitPrice) {
    console.warn('[settings] ADVISORY: priceCeiling >= takeProfitPrice — positions with entry above TP will never trigger take-profit');
  }

  // Persist
  saveToDisk(currentSettings);

  // Fire callback
  if (onChangedCallback) onChangedCallback();

  return {};
}

function readFromFile(): BotSettings | null {
  try {
    if (!fs.existsSync(CONFIG.settingsFile)) return null;

    const raw = fs.readFileSync(CONFIG.settingsFile, 'utf-8');
    const parsed = JSON.parse(raw);

    // MIGRATE: lowConvictionSize → standardSize
    if ('lowConvictionSize' in parsed) {
      if (!parsed.standardSize || parsed.standardSize === 0) {
        parsed.standardSize = parsed.lowConvictionSize;
      }
      delete parsed.lowConvictionSize;
    }

    // MIGRATE: delete activeFilter (old field)
    delete parsed.activeFilter;

    // MIGRATE: midEdgeRanges 'between' operator → pair of gte/lte
    if (Array.isArray(parsed.midEdgeRanges)) {
      const migrated: MidEdgeRange[] = [];
      for (const r of parsed.midEdgeRanges) {
        if (r.operator === 'between' && r.min !== undefined && r.max !== undefined) {
          migrated.push({ operator: 'gte', value: r.min });
          migrated.push({ operator: 'lte', value: r.max });
        } else if (['lt', 'gt', 'lte', 'gte'].includes(r.operator)) {
          migrated.push({ operator: r.operator, value: r.value });
        }
      }
      parsed.midEdgeRanges = migrated;
    }

    // DEFAULTS: fill missing new fields
    if (parsed.edgeVsSpotCeiling === undefined) parsed.edgeVsSpotCeiling = 0;
    if (parsed.inactiveHoursUTC === undefined) parsed.inactiveHoursUTC = [0, 0];
    if (parsed.whaleSizeGate === undefined) parsed.whaleSizeGate = 0;

    // FORCE: always boot to PAPER
    parsed.mode = "PAPER";

    // Save migrated version back
    saveToDisk(parsed);

    return parsed as BotSettings;
  } catch (e: any) {
    console.error('[settings] readFromFile failed:', e.message);
    return null;
  }
}

function saveToDisk(s: BotSettings): void {
  try {
    // Ensure data dir exists
    const dir = CONFIG.dataDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Atomic write: write to .tmp, rename to final path
    const tmpPath = CONFIG.settingsFile + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(s, null, 2));
    fs.renameSync(tmpPath, CONFIG.settingsFile);
  } catch (e: any) {
    console.error('[settings] saveToDisk failed:', e.message);
  }
}
