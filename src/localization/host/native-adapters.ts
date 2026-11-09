import { parse } from 'acorn';
import { ComposerError } from '../../host/contracts.js';
import { sha256 } from '../../host/hash.js';
import type { AsarEngineLike } from '../../host/features.js';
import type { AdapterEdit } from '../../host/inputs.js';

interface NativeEdit extends AdapterEdit {
  messageIds: string[];
  sourceSha256: string;
  start: number;
  end: number;
}

const engine = "require('./agyctl-localization/host-engine.js')";
const text = (id: string, original: string) => `${engine}.nativeText(${JSON.stringify(id)}, ${JSON.stringify(original)})`;
const format = (id: string, original: string, values: string) => `${engine}.nativeFormat(${JSON.stringify(id)}, ${JSON.stringify(original)}, [${values}])`;
const htmlText = (expression: string) => `(${expression}).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')`;

const roleLabels: Record<string, [string, string]> = {
  filemenu: ['menu.file', 'File'], editmenu: ['menu.edit', 'Edit'], viewmenu: ['menu.view', 'View'],
  windowmenu: ['menu.window', 'Window'], help: ['menu.help', 'Help'],
  undo: ['menu.undo', 'Undo'], redo: ['menu.redo', 'Redo'], cut: ['menu.cut', 'Cut'],
  copy: ['menu.copy', 'Copy'], paste: ['menu.paste', 'Paste'], pasteandmatchstyle: ['menu.pasteAndMatchStyle', 'Paste and Match Style'],
  delete: ['menu.delete', 'Delete'], selectall: ['menu.selectAll', 'Select All'],
  reload: ['menu.reload', 'Reload'], forcereload: ['menu.forceReload', 'Force Reload'],
  toggledevtools: ['menu.toggleDevTools', 'Toggle Developer Tools'], resetzoom: ['menu.resetZoom', 'Actual Size'],
  zoomin: ['menu.zoomIn', 'Zoom In'], zoomout: ['menu.zoomOut', 'Zoom Out'],
  togglefullscreen: ['menu.toggleFullscreen', 'Toggle Full Screen'], minimize: ['menu.minimize', 'Minimize'],
  close: ['menu.close', 'Close Window'], quit: ['session.quit', 'Quit'],
};

/** Derives byte-exact, unique edits only from the reviewed native source contexts. */
export function buildReviewedNativeEdits(engineIO: AsarEngineLike, originalPath: string): NativeEdit[] {
  const edits: NativeEdit[] = [];
  const sources = new Map<string, string>();
  function source(file: string): string {
    let value = sources.get(file);
    if (value === undefined) {
      try { value = engineIO.extractFile(originalPath, file).toString('utf8'); }
      catch (error) { throw new ComposerError('SOURCE_MISMATCH', `Native capability missing member ${file}: ${String(error)}`); }
      try { parse(value, { ecmaVersion: 'latest', sourceType: 'script' }); }
      catch (error) { throw new ComposerError('SOURCE_MISMATCH', `Native member is not valid JavaScript ${file}: ${String(error)}`); }
      sources.set(file, value);
    }
    return value;
  }
  function edit(file: string, anchor: string, replacement: string, messageIds: string[] = []) {
    const content = source(file);
    const start = content.indexOf(anchor);
    if (start < 0 || content.indexOf(anchor, start + 1) >= 0)
      throw new ComposerError('SOURCE_MISMATCH', `Native capability anchor ${start < 0 ? 'missing' : 'ambiguous'} in ${file}: ${anchor.slice(0, 120)}`);
    edits.push({ file, anchor, replaceAnchor: replacement, messageIds, sourceSha256: sha256(Buffer.from(content)), start, end: start + anchor.length });
  }
  function property(file: string, key: string, original: string, id: string) {
    const anchor = `${key}: '${original}'`;
    edit(file, anchor, `${key}: ${text(id, original)}`, [id]);
  }
  function literal(file: string, anchor: string, id: string, original: string) {
    edit(file, anchor, text(id, original), [id]);
  }

  edit('dist/main.js', 'const electron_1 = require("electron");', `const electron_1 = require("electron");\n${engine}.initializeHostRuntime();`);
  for (const [key, original, id] of [
    ['title', 'Confirm Quit', 'session.quitConfirmTitle'], ['message', 'Are you sure you want to quit?', 'session.quitConfirmMessage'],
    ['detail', 'There may be agents or background tasks running.', 'session.quitConfirmDetail'],
    ['title', 'WSL distro not found', 'startup.wslMissingTitle'], ['detail', 'Antigravity opened on Windows instead.', 'startup.openedLocally'],
    ['label', 'New Window', 'nav.newWindow'], ['label', 'Quit', 'session.quit'],
  ]) property('dist/main.js', key, original, id);
  edit('dist/main.js', "buttons: ['Cancel', 'Quit']", `buttons: [${text('common.cancel', 'Cancel')}, ${text('session.quit', 'Quit')}]`, ['common.cancel', 'session.quit']);
  edit('dist/main.js', "label: 'No agents running'", `label: ${engine}.nativeAgentsRunning(0)`, ['tray.agentsRunning']);
  edit('dist/main.js', 'label: `Open ${electron_1.app.getName()}`', `label: ${format('tray.openApplication', 'Open {0}', 'electron_1.app.getName()')}`, ['tray.openApplication']);
  edit('dist/main.js', 'message: `The WSL distro "${WSL_DISTRO}" is no longer installed.`', `message: ${format('startup.wslMissingMessage', 'The WSL distro "{0}" is no longer installed.', 'WSL_DISTRO')}`, ['startup.wslMissingMessage']);
  for (const [original, id] of [['Binary not found', 'startup.binaryMissingTitle'], ['WSL setup failed', 'startup.wslFailedTitle'], ['Startup failed', 'startup.failedTitle']])
    edit('dist/main.js', `showErrorBox('${original}', msg)`, `showErrorBox(${text(id, original)}, msg)`, [id]);
  edit('dist/main.js', '`language_server binary not found at:\\n${languageServer_1.LS_BINARY}\\n\\nPlease build set a valid location.`', format('startup.binaryMissingMessage', 'language_server binary not found at:\n{0}\n\nPlease build set a valid location.', 'languageServer_1.LS_BINARY'), ['startup.binaryMissingMessage']);
  edit('dist/main.js', '`Failed to install the server into WSL distro "${WSL_DISTRO}":\\n${err.message}`', format('startup.wslFailedMessage', 'Failed to install the server into WSL distro "{0}":\n{1}', 'WSL_DISTRO, err.message'), ['startup.wslFailedMessage']);

  for (const [key, original, id] of [['label', 'New Window', 'nav.newWindow'], ['label', 'Docs', 'nav.docs'], ['label', 'Connect to WSL', 'wsl.connect'], ['label', 'Reopen Locally', 'wsl.reopenLocally']]) property('dist/menu.js', key, original, id);
  edit('dist/menu.js', "addItemToSubmenu(menu, 'File', 0,", "addItemToSubmenu(menu, 'filemenu', 0,");
  edit('dist/menu.js', "addItemToSubmenu(menu, 'Help', 0,", "addItemToSubmenu(menu, 'help', 0,");
  edit('dist/menu.js', "addItemToSubmenu(menu, 'File', 1,", "addItemToSubmenu(menu, 'filemenu', 1,");
  edit('dist/menu.js', "addItemToSubmenu(menu, 'File', 2,", "addItemToSubmenu(menu, 'filemenu', 2,");
  edit('dist/menu.js', 'appMenu.items.find((item) => item.label === submenuLabel)', 'appMenu.items.find((item) => item.role?.toLowerCase() === submenuLabel)');
  const roleVisitor = `const agyctlRoleLabels = ${JSON.stringify(roleLabels)};\n    const agyctlLocalizeMenu = (target) => { for (const item of target.items) { const entry = agyctlRoleLabels[item.role?.toLowerCase()]; if (entry) { const original = item.label || entry[1]; let translated = ${engine}.nativeText(entry[0], original); const mnemonic = /(?:^|[^&])&([^&])/.exec(original)?.[1]; if (mnemonic && !translated.includes('&')) translated += ' (&' + mnemonic + ')'; item.label = translated; } if (item.submenu) agyctlLocalizeMenu(item.submenu); } };\n    agyctlLocalizeMenu(menu);`;
  edit('dist/menu.js', '    if (!menu) {\n        return;\n    }', `    if (!menu) {\n        return;\n    }\n    ${roleVisitor}`, Object.values(roleLabels).map(([id]) => id));
  edit('dist/menu.js', 'label: updater_1.MenuUpdateStep.CheckForUpdates', `label: ${text('update.checkForUpdates', 'Check for Updates')}`, ['update.checkForUpdates']);
  edit('dist/menu.js', 'updater_1.updateActions[menuItem.label]', 'updater_1.updateActions[updater_1.getMenuUpdateStep()]');
  const stepLabels = { CheckForUpdates: ['update.checkForUpdates', 'Check for Updates'], CheckingForUpdates: ['update.checking', 'Checking for Updates...'], DownloadingUpdate: ['update.downloading', 'Downloading Update...'], RestartToUpdate: ['update.restart', 'Restart to Update'] };
  edit('dist/updater.js', 'function updateMenuState(step) {', 'let agyctlMenuUpdateStep = MenuUpdateStep.CheckForUpdates;\nexports.getMenuUpdateStep = () => agyctlMenuUpdateStep;\nfunction updateMenuState(step) {\n    agyctlMenuUpdateStep = step;');
  const stepExpression = Object.entries(stepLabels).map(([key, [id, original]]) => `step === MenuUpdateStep.${key} ? ${text(id, original)} : `).join('') + 'step';
  edit('dist/updater.js', 'item.label = step;', `item.label = ${stepExpression};`, Object.values(stepLabels).map(([id]) => id));
  property('dist/updater.js', 'title', 'Check for Updates', 'update.checkForUpdates');
  property('dist/updater.js', 'message', 'No updates available', 'update.noUpdates');
  edit('dist/updater.js', "buttons: ['OK']", `buttons: [${text('common.ok', 'OK')}], defaultId: 0, cancelId: 0`, ['common.ok']);
  edit('dist/tray.js', "(count > 0 ? `${count}` : 'No') +\n                    ' agent' +\n                    (count === 1 ? '' : 's') +\n                    ' running'", `${engine}.nativeAgentsRunning(count)`, ['tray.agentsRunning']);

  property('dist/ipcHandlers.js', 'title', 'Open workspace', 'workspace.open');
  property('dist/ipcHandlers.js', 'title', 'Open workspaces', 'workspace.openMultiple');
  property('dist/ipcHandlers.js', 'message', 'Folder is on the Windows filesystem', 'wsl.windowsFolderTitle');
  edit('dist/ipcHandlers.js', "showErrorBox('Cannot open folder', t.error)", `showErrorBox(${text('workspace.cannotOpenFolder', 'Cannot open folder')}, t.error)`, ['workspace.cannotOpenFolder']);
  // A source-confirmed optional capability, not a fallback for a required anchor.
  if (source('dist/ipcHandlers.js').includes("title: 'Select Download Folder'")) property('dist/ipcHandlers.js', 'title', 'Select Download Folder', 'workspace.selectDownloadFolder');

  edit('dist/provisionSplash.js', '<div>Setting up WSL: ${escapeHtml(distro)}</div>', `<div>\${escapeHtml(${format('wsl.settingUp', 'Setting up WSL: {0}', 'distro')})}</div>`, ['wsl.settingUp']);
  literal('dist/wsl.js', "'Downloading the Antigravity binary\\u2026'", 'wsl.downloadingBinary', 'Downloading the Antigravity binary…');
  edit('dist/wsl.js', '`Installing into ${distro}\\u2026`', format('wsl.installing', 'Installing into {0}…', 'distro'), ['wsl.installing']);
  literal('dist/wsl.js', "'This folder is on the Windows filesystem. Accessing it from WSL (via /mnt) can be slow — for best performance keep projects inside the WSL filesystem.'", 'wsl.windowsFolderWarning', 'This folder is on the Windows filesystem. Accessing it from WSL (via /mnt) can be slow — for best performance keep projects inside the WSL filesystem.');
  edit('dist/wsl.js', '`This folder belongs to the WSL distro "${unc[1]}", but this window is connected to "${distro}".`', format('wsl.otherDistroFolder', 'This folder belongs to the WSL distro "{0}", but this window is connected to "{1}".', 'unc[1], distro'), ['wsl.otherDistroFolder']);
  edit('dist/wsl.js', '`This location cannot be opened in WSL: ${winPath}`', format('wsl.cannotOpenLocation', 'This location cannot be opened in WSL: {0}', 'winPath'), ['wsl.cannotOpenLocation']);

  property('dist/webauthn.js', 'title', 'Choose a Passkey', 'passkey.choose');
  property('dist/webauthn.js', 'detail', 'Select a passkey account to continue:', 'passkey.selectAccount');
  edit('dist/webauthn.js', 'message: `Sign in to ${rpLabel}`', `message: ${format('passkey.signIn', 'Sign in to {0}', 'rpLabel')}`, ['passkey.signIn']);
  edit('dist/webauthn.js', "buttons: [...accountLabels, 'Cancel']", `buttons: [...accountLabels, ${text('common.cancel', 'Cancel')}]`, ['common.cancel']);

  const wizard = 'dist/ideInstall/wizardHtml.js';
  edit(wizard, '<html lang="en">', `<html lang="\${${engine}.nativeCatalogLocale() ?? 'en'}">`);
  for (const [anchor, original, id] of [
    ['<title>Welcome to Antigravity</title>', 'Welcome to Antigravity', 'wizard.title'],
    ['<h1>Welcome to the new Antigravity!</h1>', 'Welcome to the new Antigravity!', 'wizard.welcome'],
    ['<span>Download the Antigravity IDE</span>', 'Download the Antigravity IDE', 'wizard.downloadIde'],
    ['>Explore the new Antigravity</button>', 'Explore the new Antigravity', 'wizard.explore'],
    ['>Setting up…</div>', 'Setting up…', 'wizard.settingUp'],
  ]) edit(wizard, anchor, anchor.replace(original, `\${${htmlText(text(id, original))}}`), [id]);
  const explanation = "Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named ";
  edit(wizard, `<p>${explanation}<b>Antigravity IDE</b>.</p>`, `<p>\${${htmlText(text('wizard.explanationBeforeIde', explanation))}}<b>Antigravity IDE</b>\${${htmlText(text('wizard.explanationAfterIde', '.'))}}</p>`, ['wizard.explanationBeforeIde', 'wizard.explanationAfterIde']);
  edit(wizard, 'alt="Antigravity Icon"', `alt="\${${htmlText(text('wizard.appIcon', 'Antigravity Icon'))}}"`, ['wizard.appIcon']);

  if (source('dist/main.js').includes('require("./deviceChooser")')) {
    const file = 'dist/deviceChooser.js';
    property(file, 'title', 'Connect a device', 'device.connectTitle');
    literal(file, "'Select a device:'", 'device.select', 'Select a device:');
    literal(file, "'No compatible devices found.'", 'device.noneFound', 'No compatible devices found.');
    edit(file, "buttons: [...snapshot.map(({ label }) => label), 'Cancel']", `buttons: [...snapshot.map(({ label }) => label), ${text('common.cancel', 'Cancel')}]`, ['common.cancel']);
    edit(file, 'message: `${origin} wants to connect to a ${KIND_NOUNS[kind]}`', `message: kind === 'hid' ? ${format('device.hidRequest', '{0} wants to connect to a HID device', 'origin')} : kind === 'usb' ? ${format('device.usbRequest', '{0} wants to connect to a USB device', 'origin')} : ${format('device.serialRequest', '{0} wants to connect to a serial port', 'origin')}`, ['device.hidRequest', 'device.usbRequest', 'device.serialRequest']);
    edit(file, "d.name?.trim() || 'Unknown device'", `d.name?.trim() || ${text('device.unknown', 'Unknown device')}`, ['device.unknown']);
    edit(file, "d.productName ?? 'Unknown device'", `d.productName ?? ${text('device.unknown', 'Unknown device')}`, ['device.unknown']);
  }
  if (source('dist/webviewBrowser.js').includes('require("./webviewPopupSecurity")')) {
    const file = 'dist/webviewPopupSecurity.js';
    for (const [original, id] of [
      ['Not secure', 'security.notSecure'], ['⚠ Not secure', 'security.dangerous'],
      ['Your connection to this site is not secure', 'security.insecureTitle'],
      ['Connection is secure', 'security.secureTitle'], ['Connection security information is not available for this page', 'security.unavailable'],
      ['Certificate is valid', 'security.validCertificate'], ['Certificate details', 'security.certificateDetails'],
      ['Connection info…', 'security.connectionInfoMenu'], ['Connection info', 'security.connectionInfoTitle'], ['This page', 'security.thisPage'],
    ]) literal(file, `'${original}'`, id, original);
    const insecure = 'You should not enter any sensitive information on this site (for example, passwords or credit cards), because it could be stolen by attackers.';
    edit(file, "'You should not enter any sensitive information on this site (for ' +\n        'example, passwords or credit cards), because it could be stolen by ' +\n        'attackers.'", text('security.insecureDetail', insecure), ['security.insecureDetail']);
    const secure = 'Your information (for example, passwords or credit card numbers) is private when it is sent to this site.';
    edit(file, "'Your information (for example, passwords or credit card numbers) is ' +\n            'private when it is sent to this site.'", text('security.secureDetail', secure), ['security.secureDetail']);
    for (const [anchor, original, value, id] of [
      ['`Error: ${state.certificateError}`', 'Error: {0}', 'state.certificateError', 'security.error'],
      ['`Issued to: ${certificate.subjectName}`', 'Issued to: {0}', 'certificate.subjectName', 'security.issuedTo'],
      ['`Issued by: ${certificate.issuer}`', 'Issued by: {0}', 'certificate.issuer', 'security.issuedBy'],
      ['`Valid from: ${formatDate(certificate.validFromMs)}`', 'Valid from: {0}', 'formatDate(certificate.validFromMs)', 'security.validFrom'],
      ['`Valid until: ${formatDate(certificate.validToMs)}`', 'Valid until: {0}', 'formatDate(certificate.validToMs)', 'security.validUntil'],
      ['`Protocol: ${certificate.protocol}`', 'Protocol: {0}', 'certificate.protocol', 'security.protocol'],
    ]) edit(file, anchor, format(id, original, value), [id]);
    edit(file, "new Date(ms).toLocaleString() : 'unknown'", `new Date(ms).toLocaleString(${engine}.nativeCatalogLocale() ?? undefined) : ${text('security.unknownDate', 'unknown')}`, ['security.unknownDate']);
    edit(file, "buttons: ['OK']", `buttons: [${text('common.ok', 'OK')}], defaultId: 0, cancelId: 0`, ['common.ok']);
    for (const role of ['cut', 'copy', 'paste', 'selectAll']) {
      const [id, original] = roleLabels[role.toLowerCase()];
      edit(file, `{ role: '${role}', enabled:`, `{ role: '${role}', label: ${text(id, original)}, enabled:`, [id]);
    }
  }

  for (const [file, content] of sources) {
    let transformed = content;
    let previous = content.length;
    for (const entry of edits.filter((entry) => entry.file === file).sort((left, right) => right.start - left.start)) {
      if (entry.end > previous) throw new ComposerError('SOURCE_MISMATCH', `Reviewed native edits overlap in ${file}`);
      transformed = transformed.slice(0, entry.start) + entry.replaceAnchor + transformed.slice(entry.end);
      previous = entry.start;
    }
    try { parse(transformed, { ecmaVersion: 'latest', sourceType: 'script' }); }
    catch (error) { throw new ComposerError('SOURCE_MISMATCH', `Native adapter generated invalid JavaScript in ${file}: ${String(error)}`); }
  }
  return edits;
}
