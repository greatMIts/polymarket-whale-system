/**
 * index.ts — Boot Sequence + Graceful Shutdown
 *
 * Layer 4 — Pure wiring + shutdown. No business logic. No state.
 * All callbacks wired here to avoid circular imports.
 */

import * as settings from './settings';
import * as positions from './positions';
import * as persistence from './persistence';
import * as clob from './clob';
import * as marketData from './market-data';
import * as whaleWatcher from './whale-watcher';
import * as trader from './trader';
import * as server from './server';
import * as logger from './logger';
import * as risk from './risk';
import { logLiveEvent } from './live-events';

async function boot() {
  console.log('═══════════════════════════════════════════');
  console.log('  V7.5 Bot System — Starting...');
  console.log('═══════════════════════════════════════════');

  // 1. Load settings from disk
  settings.loadFromDisk();

  // 2. Load trade history into positions
  positions.loadFromHistory(persistence.loadTradeHistory());

  // 3. Init CLOB client (3x retry, 1s/2s/4s backoff)
  await clob.init();

  // 4. Connect Binance WS + Polymarket WS
  await marketData.connect();

  // 5. Start whale polling
  whaleWatcher.start();

  // 6. Wire settings callback
  settings.setOnChanged(server.incrementVersion);

  // 7. Wire whale trade handler
  whaleWatcher.onWhaleTrade(trader.executeCopyTrade);

  // 8. Wire trader callback
  trader.setOnTradeOpened((trade) => {
    if (trade.mode === 'LIVE') logLiveEvent({ event: 'BUY_FILL', ...trade });
  });

  // 9. Wire position callbacks
  positions.setSellExecutor(clob.placeFokOrder);
  positions.setOnResolution(server.pushStateNow);
  positions.setOnMutation(server.incrementVersion);
  positions.setOnClosed((pos) => {
    trader.cleanupResolvedContracts([pos.conditionId]);
    if (pos.pnl !== undefined && pos.pnl !== null && pos.pnl < 0) {
      risk.recordLoss(Math.abs(pos.pnl));
    }
    if (pos.mode === 'LIVE') {
      if (pos.status === 'TP_FILLED') logLiveEvent({ event: 'TP_SELL_FILL', ...pos });
      if (pos.status === 'WON' || pos.status === 'LOST' || pos.status === 'EXPIRED') {
        logLiveEvent({ event: 'RESOLUTION', ...pos });
      }
    }
  });

  // 10. Start intervals
  setInterval(() => marketData.pollResolutions(), 30_000);           // Poll Gamma for outcomes
  setInterval(() => positions.resolveSettled(), 15_000);              // Resolve settled positions
  setInterval(() => positions.checkTakeProfit(), 10_000);             // Check take-profit
  setInterval(() => server.broadcastState(), 500);                    // Broadcast state to WS clients
  setInterval(() => risk.pruneHourlyLosses(), 30_000);                // Prune stale risk entries
  setInterval(() => positions.pruneRecentTimestamps(), 30_000);       // Prune stale trade timestamps
  setInterval(() => trader.clearOldCooldowns(), 60_000);              // Clear expired cooldowns
  setInterval(() => marketData.proactiveScan(), 30_000);              // Scan for contracts near expiry
  setInterval(() => marketData.refreshEmpty(), 15_000);               // Refresh empty order books
  setInterval(() => {                                                  // Volume/latency stats logging
    logger.logVolStats({
      openCount: positions.getOpen().length,
      exposure: positions.getTotalExposure(),
      hourlyTrades: positions.getHourlyTradeCount(),
    });
  }, 60_000);
  setInterval(() => logger.logHeartbeat(), 300_000);                   // Heartbeat every 5min
  setInterval(() => {                                                  // File rotation + safeguard every 6hr
    persistence.checkAndRotate();
    persistence.rewriteOpenPositions(positions.getOpen());
  }, 6 * 3_600_000);

  // 11. Start HTTP server
  server.listen();

  // 12. Register graceful shutdown
  process.on('SIGINT', async () => {
    logger.logEvent('SIGINT received — shutting down', 'system');
    settings.update({ botEnabled: false });
    // Wait for in-flight TPs (max 10s)
    const deadline = Date.now() + 10_000;
    while (positions.getTpInFlightIds().length > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    server.broadcastState();  // final state push
    process.exit(0);
  });
  process.on('SIGTERM', () => process.emit('SIGINT' as any));

  logger.logEvent('Boot complete — all systems wired', 'system');
}

boot().catch(err => {
  console.error('FATAL BOOT ERROR:', err);
  process.exit(1);
});
