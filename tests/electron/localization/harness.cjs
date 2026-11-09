// P0-A harness entry point: `electron harness.cjs <scenario>`. Prints one
// `#RESULT {json}` line and exits 0 on pass, 2 on failed checks, 3 on crash.
const { app } = require('electron');
const { scenarios } = require('./scenarios.cjs');

function finish(kind, payload, code) {
  process.stdout.write(`#${kind} ${JSON.stringify(payload)}\n`, () => app.exit(code));
}

const watchdog = setTimeout(() => {
  finish('FATAL', { message: 'harness watchdog fired after 120s' }, 3);
}, 120_000);
watchdog.unref();

// Scenarios destroy their own windows before the result is emitted; the
// default quit-on-last-window would kill the process mid-finally.
app.on('window-all-closed', () => {});

app
  .whenReady()
  .then(async () => {
    const name = process.argv[2];
    const scenario = scenarios[name];
    if (!scenario) {
      finish('FATAL', { message: `unknown scenario: ${name}` }, 3);
      return;
    }
    try {
      const result = await scenario();
      finish(
        'RESULT',
        { ...result, electronVersion: process.versions.electron },
        result.ok ? 0 : 2,
      );
    } catch (error) {
      finish('FATAL', { message: String(error?.stack ?? error) }, 3);
    }
  })
  .catch((error) => {
    finish('FATAL', { message: String(error?.stack ?? error) }, 3);
  });
