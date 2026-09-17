// @ts-check
const fs = require('fs');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');

// NODE_OPTIONS also reaches subprocesses. Only the specific daemon entry point
// may install this hook; browser workers and user programs must be unaffected.
if (path.basename(process.argv[1] || '') === 'cliDaemon.js' && process.env.STEALTH_CLI_LIFECYCLE) {
  const settings = JSON.parse(process.env.STEALTH_CLI_LIFECYCLE);
  delete process.env.STEALTH_CLI_LIFECYCLE;
  install(settings);
}

/**
 * Track the CLI server's connections, never page contents or command payloads.
 * A connected command suspends expiry; idle time starts again when it finishes.
 * @param {{directory: string, idleSeconds: number, daemonProfilesDir: string}} settings
 */
function install(settings) {
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(...args) {
    const socketPath = args[0];
    if (typeof socketPath === 'string' && (path.basename(path.dirname(socketPath)) === 'cli' || (process.platform === 'win32' && socketPath.includes('-cli-')))) {
      net.Server.prototype.listen = originalListen;
      monitor(this, socketPath, settings);
    }
    return originalListen.apply(this, args);
  };
}

/**
 * Expire this daemon via Playwright's own graceful shutdown, which closes the
 * owned browser tree and runs its existing session/config cleanup handlers.
 * @param {import('net').Server} server
 * @param {string} socketPath
 * @param {{directory: string, idleSeconds: number, daemonProfilesDir: string}} settings
 */
function monitor(server, socketPath, settings) {
  let active = 0;
  let lastUsed = Date.now();
  let stopping = false;
  const recordPath = path.join(settings.directory, `${process.pid}-${randomUUID()}.json`);
  const record = { pid: process.pid, name: process.argv[2] || 'default', socketPath, startedAt: lastUsed };
  server.on('connection', socket => {
    active++;
    socket.once('close', () => {
      active--;
      lastUsed = Date.now();
    });
  });
  server.once('listening', () => {
    fs.writeFileSync(`${recordPath}.tmp`, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(`${recordPath}.tmp`, recordPath);
    const originalStat = process.platform === 'win32' ? null : fs.statSync(socketPath);
    let ownershipChecked = false;
    const timer = setInterval(() => {
      // Explicit config can attach even without --cdp/--endpoint on argv.
      // Upstream records ownership after listening; never expire attachments.
      const sessionFile = path.join(settings.daemonProfilesDir, `${record.name}.session`);
      if (!ownershipChecked) {
        try {
          const config = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
          if (config.attached) {
            clearInterval(timer);
            fs.rmSync(recordPath, { force: true });
            return;
          }
          ownershipChecked = true;
        } catch (error) {
          // Upstream writes the session file asynchronously after listen.
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
          throw error;
        }
      }
      let orphaned = false;
      if (originalStat) {
        try {
          const current = fs.statSync(socketPath);
          orphaned = current.ino !== originalStat.ino || current.dev !== originalStat.dev;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          orphaned = true;
        }
      }
      const expired = settings.idleSeconds > 0 && active === 0 && Date.now() - lastUsed >= settings.idleSeconds * 1000;
      if (!stopping && (orphaned || expired)) {
        stopping = true;
        clearInterval(timer);
        const { utils } = require('playwright-core/lib/coreBundle');
        utils.gracefullyProcessExitDoNotHang(0, async () => {
          if (originalStat) {
            try {
              const current = await fs.promises.stat(socketPath);
              if (current.ino === originalStat.ino && current.dev === originalStat.dev)
                await fs.promises.unlink(socketPath);
            } catch (error) {
              if (error.code !== 'ENOENT') console.error('[stealth-web-cli] Could not remove expired session socket.');
            }
          }
          const sessionFile = path.join(settings.daemonProfilesDir, `${record.name}.session`);
          try {
            const config = JSON.parse(await fs.promises.readFile(sessionFile, 'utf8'));
            if (config.socketPath === socketPath && config.timestamp <= record.startedAt && !config.cli?.persistent)
              await fs.promises.rm(sessionFile, { force: true });
          } catch (error) {
            if (error.code !== 'ENOENT') console.error('[stealth-web-cli] Could not remove expired session metadata.');
          }
        });
      }
    }, 250);
    timer.unref();
  });
  process.once('exit', () => {
    // Best-effort metadata cleanup; a killed process is pruned on the next open.
    try { fs.rmSync(recordPath, { force: true }); } catch (error) {
      if (error.code !== 'ENOENT') console.error('[stealth-web-cli] Could not remove session lifecycle metadata.');
    }
  });
}
