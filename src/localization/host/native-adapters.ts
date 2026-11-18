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

// The host engine runtime is installed at dist/agyctl-localization/, so the
// require path depends on the target member's depth below dist/ — nested
// members (for example dist/nested/member.js) must step up one extra level.
const ENGINE_TOKEN = '__AGYCTL_ENGINE__';
const text = (id: string, original: string) => `${ENGINE_TOKEN}.nativeText(${JSON.stringify(id)}, ${JSON.stringify(original)})`;
const format = (id: string, original: string, values: string) => `${ENGINE_TOKEN}.nativeFormat(${JSON.stringify(id)}, ${JSON.stringify(original)}, [${values}])`;
const htmlText = (expression: string) => `(${expression}).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')`;
/** Relative require specifier for the host engine runtime from a patched member. */
export function engineRequirePath(file: string): string {
  const levels = file.split('/').length - 1;
  return `require('${levels > 1 ? '../' : './'}agyctl-localization/host-engine.js')`;
}

const roleLabels: Record<string, [string, string]> = {
  filemenu: ['menu.file', 'File'], editmenu: ['menu.edit', 'Edit'], viewmenu: ['menu.view', 'View'],
  windowmenu: ['menu.window', 'Window'], help: ['menu.help', 'Help'],
  undo: ['menu.undo', 'Undo'], redo: ['menu.redo', 'Redo'], cut: ['menu.cut', 'Cut'],
  copy: ['menu.copy', 'Copy'], paste: ['menu.paste', 'Paste'], pasteandmatchstyle: ['menu.pasteAndMatchStyle', 'Paste and Match Style'],
  delete: ['menu.delete', 'Delete'], selectall: ['menu.selectAll', 'Select All'],
  reload: ['menu.reload', 'Reload'], forcereload: ['menu.forceReload', 'Force Reload'],
  toggledevtools: ['menu.toggleDevTools', 'Toggle Developer Tools'], resetzoom: ['menu.resetZoom', 'Actual Size'],
  zoom: ['menu.zoom', 'Zoom'], zoomin: ['menu.zoomIn', 'Zoom In'], zoomout: ['menu.zoomOut', 'Zoom Out'],
  togglefullscreen: ['menu.toggleFullscreen', 'Toggle Full Screen'], minimize: ['menu.minimize', 'Minimize'],
  close: ['menu.close', 'Close Window'], quit: ['session.quit', 'Quit'],
};

/** Derives byte-exact, unique edits only from the reviewed native source contexts. */
export function buildReviewedNativeEdits(engineIO: AsarEngineLike, originalPath: string, adapterVersion: '2' | '3' | '4' = '2'): NativeEdit[] {
  if (adapterVersion !== '2' && adapterVersion !== '3' && adapterVersion !== '4')
    throw new ComposerError('SOURCE_MISMATCH', `Unknown native localization adapter version: ${String(adapterVersion)}`);
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
  function requireAnchor(file: string, anchor: string) {
    const content = source(file);
    const start = content.indexOf(anchor);
    if (start < 0 || content.indexOf(anchor, start + 1) >= 0)
      throw new ComposerError('SOURCE_MISMATCH', `Native capability anchor ${start < 0 ? 'missing' : 'ambiguous'} in ${file}: ${anchor.slice(0, 120)}`);
    return { content, start };
  }
  function edit(file: string, anchor: string, replacement: string, messageIds: string[] = []) {
    const { content, start } = requireAnchor(file, anchor);
    const resolved = replacement.replaceAll(ENGINE_TOKEN, engineRequirePath(file));
    edits.push({ file, anchor, replaceAnchor: resolved, messageIds, sourceSha256: sha256(Buffer.from(content)), start, end: start + anchor.length });
  }
  function property(file: string, key: string, original: string, id: string) {
    const anchor = `${key}: '${original}'`;
    edit(file, anchor, `${key}: ${text(id, original)}`, [id]);
  }
  function literal(file: string, anchor: string, id: string, original: string) {
    edit(file, anchor, text(id, original), [id]);
  }

  edit('dist/main.js', 'const electron_1 = require("electron");', `const electron_1 = require("electron");\n${ENGINE_TOKEN}.initializeHostRuntime();`);
  for (const [key, original, id] of [
    ['title', 'Confirm Quit', 'session.quitConfirmTitle'], ['message', 'Are you sure you want to quit?', 'session.quitConfirmMessage'],
    ['detail', 'There may be agents or background tasks running.', 'session.quitConfirmDetail'],
    ['title', 'WSL distro not found', 'startup.wslMissingTitle'], ['detail', 'Antigravity opened on Windows instead.', 'startup.openedLocally'],
    ['label', 'New Window', 'nav.newWindow'], ['label', 'Quit', 'session.quit'],
  ]) property('dist/main.js', key, original, id);
  edit('dist/main.js', "buttons: ['Cancel', 'Quit']", `buttons: [${text('common.cancel', 'Cancel')}, ${text('session.quit', 'Quit')}]`, ['common.cancel', 'session.quit']);
  edit('dist/main.js', "label: 'No agents running'", `label: ${ENGINE_TOKEN}.nativeAgentsRunning(0)`, ['tray.agentsRunning']);
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
  const roleVisitor = `const agyctlRoleLabels = ${JSON.stringify(roleLabels)};\n    const agyctlLocalizeMenu = (target) => { for (const item of target.items) { const entry = agyctlRoleLabels[item.role?.toLowerCase()]; if (entry) { const original = item.label || entry[1]; let translated = ${ENGINE_TOKEN}.nativeText(entry[0], original); const mnemonic = /(?:^|[^&])&([^&])/.exec(original)?.[1]; if (mnemonic && !translated.includes('&')) translated += ' (&' + mnemonic + ')'; item.label = translated; } if (item.submenu) agyctlLocalizeMenu(item.submenu); } };\n    agyctlLocalizeMenu(menu);`;
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
  edit('dist/tray.js', "(count > 0 ? `${count}` : 'No') +\n                    ' agent' +\n                    (count === 1 ? '' : 's') +\n                    ' running'", `${ENGINE_TOKEN}.nativeAgentsRunning(count)`, ['tray.agentsRunning']);

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
    edit(file, "new Date(ms).toLocaleString() : 'unknown'", `new Date(ms).toLocaleString(${ENGINE_TOKEN}.nativeCatalogLocale() ?? undefined) : ${text('security.unknownDate', 'unknown')}`, ['security.unknownDate']);
    edit(file, "buttons: ['OK']", `buttons: [${text('common.ok', 'OK')}], defaultId: 0, cancelId: 0`, ['common.ok']);
    for (const role of ['cut', 'copy', 'paste', 'selectAll']) {
      const [id, original] = roleLabels[role.toLowerCase()];
      edit(file, `{ role: '${role}', enabled:`, `{ role: '${role}', label: ${text(id, original)}, enabled:`, [id]);
    }
  }

  if (adapterVersion === '3' || adapterVersion === '4') {
    edit("dist/remote/remoteManager.js", "title: 'Choose an SSH config file'", `title: ${text("ssh.chooseConfigFile", "Choose an SSH config file")}`, ["ssh.chooseConfigFile"]);
    edit("dist/remote/remoteManager.js", "title: 'SSH connection failed'", `title: ${text("ssh.connectionFailedTitle", "SSH connection failed")}`, ["ssh.connectionFailedTitle"]);
    edit("dist/remote/remoteManager.js", "this.reportError(err, entry.label, 'Sign-in failed', win)", `this.reportError(err, entry.label, ${text("ssh.signInFailed", "Sign-in failed")}, win)`, ["ssh.signInFailed"]);
    edit("dist/remote/remoteManager.js", "this.reportError(err, entry.label, 'Could not stop the SSH server', win)", `this.reportError(err, entry.label, ${text("ssh.stopFailedTitle", "Could not stop the SSH server")}, win)`, ["ssh.stopFailedTitle"]);
    if (adapterVersion === '3') edit("dist/remote/remoteManager.js", "\n                title: 'Stop SSH server'", `\n                title: ${text("ssh.stopServerTitle", "Stop SSH server")}`, ["ssh.stopServerTitle"]);
    edit("dist/remote/remoteManager.js", "\n            title: 'Stop SSH server'", `\n            title: ${text("ssh.stopServerTitle", "Stop SSH server")}`, ["ssh.stopServerTitle"]);
    edit("dist/remote/remoteManager.js", "`Stop the Antigravity server on ${entry.label}?`", format("ssh.stopServerConfirm", "Stop the Antigravity server on {0}?", "entry.label"), ["ssh.stopServerConfirm"]);
    if (adapterVersion === '3') edit("dist/remote/remoteManager.js", "'Agents running on this host will stop and its window will close. ' +\n                    'The server starts again the next time you connect.'", text("ssh.stopServerDetail", "Agents running on this host will stop and its window will close. The server starts again the next time you connect."), ["ssh.stopServerDetail"]);
    edit("dist/remote/remoteManager.js", "`Not connected to ${label}`", format("ssh.notConnectedTo", "Not connected to {0}", "label"), ["ssh.notConnectedTo"]);
    edit("dist/remote/remoteManager.js", "'Reconnect first, then stop its server.'", text("ssh.reconnectBeforeStop", "Reconnect first, then stop its server."), ["ssh.reconnectBeforeStop"]);
    if (adapterVersion === '3') edit("dist/remote/remoteManager.js", "title: 'Sign in'", `title: ${text("ssh.signInTitle", "Sign in")}`, ["ssh.signInTitle"]);
    if (adapterVersion === '3') edit("dist/remote/remoteManager.js", "`Sign in to your organization for ${entry.label}?`", format("ssh.organizationSignInConfirm", "Sign in to your organization for {0}?", "entry.label"), ["ssh.organizationSignInConfirm"]);
    edit("dist/remote/remoteManager.js", "'Continue only if you just chose to sign in with your organization ' +\n                `in this window. ${entry.label} will get access to your ` +\n                \"organization's Google Cloud account.\\n\"", format("ssh.organizationSignInDetail", "Continue only if you just chose to sign in with your organization in this window. {0} will get access to your organization's Google Cloud account.\n", "entry.label"), ["ssh.organizationSignInDetail"]);
    edit("dist/remote/remoteManager.js", "`Workforce pool: ${names[1]}  Provider: ${names[2]}`", format("ssh.workforceProvider", "Workforce pool: {0}  Provider: {1}", "names[1], names[2]"), ["ssh.workforceProvider"]);
    edit("dist/remote/remoteManager.js", "`Identity provider: ${provider}`", format("ssh.identityProvider", "Identity provider: {0}", "provider"), ["ssh.identityProvider"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Stop Server', 'Cancel']", `buttons: [${text("ssh.stopServerAction", "Stop Server")}, ${text("common.cancel", "Cancel")}]`, ["ssh.stopServerAction","common.cancel"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Sign In', 'Cancel']", `buttons: [${text("ssh.signInAction", "Sign In")}, ${text("common.cancel", "Cancel")}]`, ["ssh.signInAction","common.cancel"]);
    edit("dist/remote/sshPrompts.js", "<div id=\"retry\" class=\"note\" hidden>Asked again: your last answer may not have worked.</div>", "<div id=\"retry\" class=\"note\" hidden>" + "\${" + htmlText(text("ssh.promptRetry", "Asked again: your last answer may not have worked.")) + "}" + "</div>", ["ssh.promptRetry"]);
    if (adapterVersion === '3') edit("dist/remote/sshPrompts.js", "<div id=\"long\" class=\"note\" hidden>That's too long.</div>", "<div id=\"long\" class=\"note\" hidden>" + "\${" + htmlText(text("ssh.promptTooLong", "That's too long.")) + "}" + "</div>", ["ssh.promptTooLong"]);
    if (adapterVersion === '3') edit("dist/remote/sshPrompts.js", "<button id=\"cancel\">Cancel</button>", "<button id=\"cancel\">" + "\${" + htmlText(text("common.cancel", "Cancel")) + "}" + "</button>", ["common.cancel"]);
    if (adapterVersion === '3') edit("dist/remote/sshPrompts.js", "<button id=\"continue\">Continue</button>", "<button id=\"continue\">" + "\${" + htmlText(text("common.continue", "Continue")) + "}" + "</button>", ["common.continue"]);
    edit("dist/remote/sshPrompts.js", "`SSH: ${label}`", format("ssh.promptTitle", "SSH: {0}", "label"), ["ssh.promptTitle"]);
    edit("dist/remote/sshPrompts.js", "`SSH: ${text.label}`", format("ssh.promptTitle", "SSH: {0}", "text.label"), ["ssh.promptTitle"]);
    if (adapterVersion === '3') edit("dist/remote/sshPrompts.js", "message: confirm ? `${label} asks:` : 'Touch your security key'", `message: confirm ? ${format("ssh.promptAsks", "{0} asks:", "label")} : ${text("ssh.touchSecurityKey", "Touch your security key")}`, ["ssh.promptAsks","ssh.touchSecurityKey"]);
    edit("dist/remote/sshPrompts.js", "buttons: confirm ? ['Yes', 'No'] : ['Cancel']", `buttons: confirm ? [${text("ssh.yes", "Yes")}, ${text("ssh.no", "No")}] : [${text("common.cancel", "Cancel")}]`, ["ssh.yes","ssh.no","common.cancel"]);
    if (adapterVersion === '3') edit("dist/remote/sshPrompts.js", "contents.send('ssh-prompt:show', text);", `contents.send('ssh-prompt:show', { ...text, asks: ${format("ssh.promptAsks", "{0} asks:", "text.label")} });`, ["ssh.promptAsks"]);
    if (adapterVersion === '3') edit("dist/remote/sshPromptPreload.js", "(_event, { label, message, retry })", "(_event, { label, message, retry, asks: localizedAsks })", []);
    if (adapterVersion === '3') edit("dist/remote/sshPromptPreload.js", "asks.textContent = `${label} asks:`;", "asks.textContent = localizedAsks ?? `${label} asks:`;", []);
    edit("dist/remote/sshBridge.js", "'The SSH config file must be a path of at most 4 KiB.'", text("ssh.configPathLimit", "The SSH config file must be a path of at most 4 KiB."), ["ssh.configPathLimit"]);
    edit("dist/remote/sshBridge.js", "'Enter an SSH host, for example \"devbox\" or \"user@host\".'", text("ssh.enterHost", "Enter an SSH host, for example \"devbox\" or \"user@host\"."), ["ssh.enterHost"]);
    edit("dist/remote/sshErrorText.js", "`Error code: ${err.code}\\nLogs: ${logPath()}`", format("ssh.codeAndLogs", "Error code: {0}\nLogs: {1}", "err.code, logPath()"), ["ssh.codeAndLogs"]);
    edit("dist/remote/sshErrorText.js", "`${label} reported: ${text}`", format("ssh.reportedError", "{0} reported: {1}", "label, text"), ["ssh.reportedError"]);
    edit("dist/remote/sshErrorText.js", "'The connection was closed before it finished.'", text("ssh.connectionClosedEarly", "The connection was closed before it finished."), ["ssh.connectionClosedEarly"]);
    if (adapterVersion === '3') edit("dist/remote/sshErrorText.js", "`${what}\\nFile: ${note} on ${label}`", format("ssh.sharedHomeFile", "{0}\nFile: {1} on {2}", "what, note, label"), ["ssh.sharedHomeFile"]);
    edit("dist/remote/sshErrorText.js", "`${text}\\nLogs: ${logPath()}`", format("ssh.errorWithLogs", "{0}\nLogs: {1}", "text, logPath()"), ["ssh.errorWithLogs"]);
    edit("dist/remote/sshArgs.js", "'Invalid SSH config file.'", text("ssh.invalidConfig", "Invalid SSH config file."), ["ssh.invalidConfig"]);
    edit("dist/remote/sshArgs.js", "'SSH authentication failed. Check your password, code or keys, then try again.'", text("ssh.authFailed", "SSH authentication failed. Check your password, code or keys, then try again."), ["ssh.authFailed"]);
    edit("dist/remote/sshArgs.js", "'SSH authentication failed. Click Reconnect to sign in again.'", text("ssh.authReconnect", "SSH authentication failed. Click Reconnect to sign in again."), ["ssh.authReconnect"]);
    edit("dist/remote/sshArgs.js", "\"SSH authentication failed. Antigravity can't answer password or code prompts on Windows yet: set up key-based login with ssh-agent, then try again.\"", text("ssh.authWindows", "SSH authentication failed. Antigravity can't answer password or code prompts on Windows yet: set up key-based login with ssh-agent, then try again."), ["ssh.authWindows"]);
    edit("dist/remote/sshArgs.js", "\"That SSH host isn't valid. Enter an alias from your SSH config or a host like user@host or user@host:2222.\"", text("ssh.invalidDestination", "That SSH host isn't valid. Enter an alias from your SSH config or a host like user@host or user@host:2222."), ["ssh.invalidDestination"]);
    edit("dist/remote/sshArgs.js", "\"The host's SSH key is unknown or has changed. Save it with ssh in a terminal. If it changed, ask the host's owner first: the connection may be intercepted.\"", text("ssh.hostKeyWindows", "The host's SSH key is unknown or has changed. Save it with ssh in a terminal. If it changed, ask the host's owner first: the connection may be intercepted."), ["ssh.hostKeyWindows"]);
    edit("dist/remote/sshArgs.js", "\"The host's SSH key has changed or isn't trusted. If it changed, ask the host's owner first: the connection may be intercepted.\"", text("ssh.hostKeyChanged", "The host's SSH key has changed or isn't trusted. If it changed, ask the host's owner first: the connection may be intercepted."), ["ssh.hostKeyChanged"]);
    edit("dist/remote/sshArgs.js", "'SSH port forwarding failed. Make sure the server allows TCP forwarding (AllowTcpForwarding) for your account, then try again.'", text("ssh.forwardingFailed", "SSH port forwarding failed. Make sure the server allows TCP forwarding (AllowTcpForwarding) for your account, then try again."), ["ssh.forwardingFailed"]);
    if (adapterVersion === '3') edit("dist/remote/sshArgs.js", "\"The SSH host isn't supported. Antigravity needs Linux on x64 or arm64 with glibc 2.26 or newer.\"", text("ssh.unsupportedHost", "The SSH host isn't supported. Antigravity needs Linux on x64 or arm64 with glibc 2.26 or newer."), ["ssh.unsupportedHost"]);
    if (adapterVersion === '3') edit("dist/remote/sshArgs.js", "'Another host that shares your home directory runs the Antigravity server. Connect to that host instead.'", text("ssh.sharedHome", "Another host that shares your home directory runs the Antigravity server. Connect to that host instead."), ["ssh.sharedHome"]);
    edit("dist/remote/sshArgs.js", "\"Couldn't install the Antigravity server on the SSH host. Make sure it has free disk space, and that it or this computer can download from the internet.\"", text("ssh.installFailed", "Couldn't install the Antigravity server on the SSH host. Make sure it has free disk space, and that it or this computer can download from the internet."), ["ssh.installFailed"]);
    edit("dist/remote/sshArgs.js", "'The Antigravity server on the SSH host stopped. Reconnect to start it again.'", text("ssh.serverStopped", "The Antigravity server on the SSH host stopped. Reconnect to start it again."), ["ssh.serverStopped"]);
    edit("dist/remote/sshArgs.js", "'The SSH connection closed. Check your network connection, then reconnect.'", text("ssh.connectionClosed", "The SSH connection closed. Check your network connection, then reconnect."), ["ssh.connectionClosed"]);
    edit("dist/remote/sshArgs.js", "'The connection was cancelled.'", text("ssh.connectionCancelled", "The connection was cancelled."), ["ssh.connectionCancelled"]);
    edit("dist/remote/sshArgs.js", "\"Couldn't connect to the SSH host. Try ssh to it in a terminal, and see the Antigravity log for details.\"", text("ssh.unknownError", "Couldn't connect to the SSH host. Try ssh to it in a terminal, and see the Antigravity log for details."), ["ssh.unknownError"]);
    edit("dist/remote/sshArgs.js", "`Couldn't connect to the SSH host (${String(code)}).`", format("ssh.unknownErrorCode", "Couldn't connect to the SSH host ({0}).", "String(code)"), ["ssh.unknownErrorCode"]);
    edit("dist/remote/sshArgs.js", "`Couldn't connect to the SSH host. Check its name, your network and ssh config (e.g. a ProxyCommand), and that ssh to it works in a terminal${prompts === 'no' ? ' without a prompt' : ''}.`", `prompts === 'no' ? ${text("ssh.connectionFailedAdviceWindows", "Couldn't connect to the SSH host. Check its name, your network and ssh config (e.g. a ProxyCommand), and that ssh to it works in a terminal without a prompt.")} : ${text("ssh.connectionFailedAdvice", "Couldn't connect to the SSH host. Check its name, your network and ssh config (e.g. a ProxyCommand), and that ssh to it works in a terminal.")}`, ["ssh.connectionFailedAdviceWindows","ssh.connectionFailedAdvice"]);
    edit("dist/remote/sshArgs.js", "`The Antigravity server failed to start on the SSH host. See its log in ~/${types_1.REMOTE_INSTALL_ROOT}/data on that host.`", format("ssh.serverStartFailed", "The Antigravity server failed to start on the SSH host. See its log in ~/{0}/data on that host.", "types_1.REMOTE_INSTALL_ROOT"), ["ssh.serverStartFailed"]);
    edit("dist/remote/disconnectedPage.js", "'Reconnecting…'", `escapeHtml(${text("ssh.reconnecting", "Reconnecting…")})`, ["ssh.reconnecting"]);
    edit("dist/remote/disconnectedPage.js", "'Disconnected'", `escapeHtml(${text("ssh.disconnected", "Disconnected")})`, ["ssh.disconnected"]);
    edit("dist/remote/disconnectedPage.js", "`Reconnecting to ${host}…`", `escapeHtml(${format("ssh.reconnectingTo", "Reconnecting to {0}…", "page.label")})`, ["ssh.reconnectingTo"]);
    edit("dist/remote/disconnectedPage.js", "`Disconnected from ${host}`", `escapeHtml(${format("ssh.disconnectedFrom", "Disconnected from {0}", "page.label")})`, ["ssh.disconnectedFrom"]);
    edit("dist/remote/disconnectedPage.js", "`Agents keep running on ${host}.`", `escapeHtml(${format("ssh.agentsKeepRunning", "Agents keep running on {0}.", "page.label")})`, ["ssh.agentsKeepRunning"]);
    edit("dist/remote/disconnectedPage.js", "`Agents keep running on ${host} unless its server stopped.`", `escapeHtml(${format("ssh.agentsMayKeepRunning", "Agents keep running on {0} unless its server stopped.", "page.label")})`, ["ssh.agentsMayKeepRunning"]);
    if (adapterVersion === '3') edit("dist/remote/disconnectedPage.js", ">Reconnect</a>", ">\${" + htmlText(text("ssh.reconnect", "Reconnect")) + "}</a>", ["ssh.reconnect"]);
    if (adapterVersion === '3') edit("dist/remote/disconnectedPage.js", ">Close</a>", ">\${" + htmlText(text("ssh.closeWindow", "Close")) + "}</a>", ["ssh.closeWindow"]);
    edit("dist/remote/sshConnection.js", "`Checking ${label}…`", format("ssh.statusChecking", "Checking {0}…", "label"), ["ssh.statusChecking"]);
    edit("dist/remote/sshConnection.js", "`Waiting for another window to finish installing on ${label}…`", format("ssh.statusWaiting", "Waiting for another window to finish installing on {0}…", "label"), ["ssh.statusWaiting"]);
    edit("dist/remote/sshConnection.js", "`Replacing an invalid server binary on ${label}…`", format("ssh.statusReplacing", "Replacing an invalid server binary on {0}…", "label"), ["ssh.statusReplacing"]);
    edit("dist/remote/sshConnection.js", "`Downloading the Antigravity server on ${label}…`", format("ssh.statusDownloading", "Downloading the Antigravity server on {0}…", "label"), ["ssh.statusDownloading"]);
    edit("dist/remote/sshConnection.js", "`Installed the Antigravity server on ${label}.`", format("ssh.statusInstalled", "Installed the Antigravity server on {0}.", "label"), ["ssh.statusInstalled"]);
    edit("dist/remote/sshConnection.js", "`Starting the Antigravity server on ${label}…`", format("ssh.statusStarting", "Starting the Antigravity server on {0}…", "label"), ["ssh.statusStarting"]);
    edit("dist/remote/sshConnection.js", "`Connecting to the running server on ${label}…`", format("ssh.statusAttaching", "Connecting to the running server on {0}…", "label"), ["ssh.statusAttaching"]);
    edit("dist/remote/sshConnection.js", "`Timed out connecting to ${this.label}.`", format("ssh.timedOut", "Timed out connecting to {0}.", "this.label"), ["ssh.timedOut"]);
    edit("dist/remote/sshConnection.js", "`The Antigravity server on ${this.label} has no HTTP port to stop it through.`", format("ssh.noStopPort", "The Antigravity server on {0} has no HTTP port to stop it through.", "this.label"), ["ssh.noStopPort"]);
    edit("dist/remote/sshConnection.js", "`The Antigravity server on ${this.label} refused to stop (HTTP ${status}).`", format("ssh.stopRefused", "The Antigravity server on {0} refused to stop (HTTP {1}).", "this.label, status"), ["ssh.stopRefused"]);
    edit("dist/remote/sshConnection.js", "`Could not confirm that the Antigravity server on ${this.label} stopped`", format("ssh.stopUnconfirmed", "Could not confirm that the Antigravity server on {0} stopped", "this.label"), ["ssh.stopUnconfirmed"]);
    edit("dist/remote/sshConnection.js", "`Could not run \"${sshBin}\". Install OpenSSH or set ANTIGRAVITY_SSH_BIN.`", format("ssh.binaryMissing", "Could not run \"{0}\". Install OpenSSH or set ANTIGRAVITY_SSH_BIN.", "sshBin"), ["ssh.binaryMissing"]);
    edit("dist/remote/sshConnection.js", "`Could not run ssh: ${err.message}`", format("ssh.runFailed", "Could not run ssh: {0}", "err.message"), ["ssh.runFailed"]);
    edit("dist/remote/sshConnection.js", "`ssh could not listen on its SOCKS port ${this.socksPort}.`", format("ssh.socksPortFailed", "ssh could not listen on its SOCKS port {0}.", "this.socksPort"), ["ssh.socksPortFailed"]);
    edit("dist/remote/sshConnection.js", "`${this.label} asked for an upload it can't need.`", format("ssh.unexpectedUpload", "{0} asked for an upload it can't need.", "this.label"), ["ssh.unexpectedUpload"]);
    edit("dist/remote/sshConnection.js", "`${this.label} sent a line longer than ${MAX_LINE_CHARS} characters.`", format("ssh.lineTooLong", "{0} sent a line longer than {1} characters.", "this.label, MAX_LINE_CHARS"), ["ssh.lineTooLong"]);
    edit("dist/remote/sshConnection.js", "`Neither ${this.label} nor this computer could download the Antigravity server: ${errorMessage(err)}`", format("ssh.downloadFailed", "Neither {0} nor this computer could download the Antigravity server: {1}", "this.label, errorMessage(err)"), ["ssh.downloadFailed"]);
    edit("dist/remote/sshConnection.js", "`The Antigravity server on ${this.label} stopped.`", format("ssh.hostServerStopped", "The Antigravity server on {0} stopped.", "this.label"), ["ssh.hostServerStopped"]);
    edit("dist/remote/sshConnection.js", "`The connection to ${this.label} was lost: ${describeExit(code, signal, this.stderrTail)}`", format("ssh.connectionLost", "The connection to {0} was lost: {1}", "this.label, describeExit(code, signal, this.stderrTail)"), ["ssh.connectionLost"]);
    edit("dist/remote/sshConnection.js", "`The Antigravity server on ${this.label} did not respond through the SSH tunnel (${(0, types_1.sanitizeRemoteText)(lastErr, 200)}).`", format("ssh.tunnelUnresponsive", "The Antigravity server on {0} did not respond through the SSH tunnel ({1}).", "this.label, (0, types_1.sanitizeRemoteText)(lastErr, 200)"), ["ssh.tunnelUnresponsive"]);
    edit("dist/remote/sshConnection.js", "`ssh exited (${how}): ${(0, types_1.sanitizeRemoteText)(lastLine, 300)}`", format("ssh.exitedWithError", "ssh exited ({0}): {1}", "how, (0, types_1.sanitizeRemoteText)(lastLine, 300)"), ["ssh.exitedWithError"]);
    edit("dist/remote/sshConnection.js", "`ssh exited (${how}).`", format("ssh.exited", "ssh exited ({0}).", "how"), ["ssh.exited"]);
    edit("dist/remote/sshConnection.js", "'Waiting for your answer…'", text("ssh.waitingAnswer", "Waiting for your answer…"), ["ssh.waitingAnswer"]);
    edit("dist/remote/sshConnection.js", "'Sign-in cancelled.'", text("ssh.signInCancelled", "Sign-in cancelled."), ["ssh.signInCancelled"]);
    edit("dist/remote/sshConnection.js", "\"Couldn't answer ssh's prompt.\"", text("ssh.promptFailed", "Couldn't answer ssh's prompt."), ["ssh.promptFailed"]);
    edit("dist/remote/sshConnection.js", "'The SSH server does not allow port forwarding (AllowTcpForwarding).'", text("ssh.forwardingNotAllowed", "The SSH server does not allow port forwarding (AllowTcpForwarding)."), ["ssh.forwardingNotAllowed"]);
    edit("dist/remote/sshConnection.js", "`${this.label} did not start the setup within ${Math.round(firstLineMs / 1000)} s. ` +\n                    'ssh (e.g. a ProxyCommand or ProxyJump login) or a command in ' +\n                    'your shell startup files (e.g. ~/.bashrc) may be waiting for input.'", format("ssh.setupWaiting", "{0} did not start the setup within {1} s. ssh (e.g. a ProxyCommand or ProxyJump login) or a command in your shell startup files (e.g. ~/.bashrc) may be waiting for input.", "this.label, Math.round(firstLineMs / 1000)"), ["ssh.setupWaiting"]);
    edit("dist/remote/sshConnection.js", "`The sign-in request of the Antigravity server on ${this.label} doesn't match what this app expects, so it was not opened. ` +\n                    'Update Antigravity, or restart the server on that host.'", format("ssh.signInRequestMismatch", "The sign-in request of the Antigravity server on {0} doesn't match what this app expects, so it was not opened. Update Antigravity, or restart the server on that host.", "this.label"), ["ssh.signInRequestMismatch"]);
    edit("dist/remote/sshConnection.js", "`Local port ${port} is in use, so the sign-in callback can't ` +\n                `reach ${this.label}. Close the program using it and sign in again. ` +\n                `(${errorMessage(err)})`", format("ssh.signInPortInUse", "Local port {0} is in use, so the sign-in callback can't reach {1}. Close the program using it and sign in again. ({2})", "port, this.label, errorMessage(err)"), ["ssh.signInPortInUse"]);
    edit("dist/remote/sshDestination.js", "\n        invalid('The user name before \"@\" is missing.');", "\n        invalid(" + text("ssh.userMissing", "The user name before \"@\" is missing.") + ");", ["ssh.userMissing"]);
    edit("dist/remote/sshDestination.js", "\n            invalid('The user name before \"@\" is missing.');", "\n            invalid(" + text("ssh.userMissing", "The user name before \"@\" is missing.") + ");", ["ssh.userMissing"]);
    edit("dist/remote/sshDestination.js", "'The user name must not start with \"-\".'", text("ssh.userDash", "The user name must not start with \"-\"."), ["ssh.userDash"]);
    edit("dist/remote/sshDestination.js", "'The host name is missing.'", text("ssh.hostMissing", "The host name is missing."), ["ssh.hostMissing"]);
    edit("dist/remote/sshDestination.js", "'The host name must not start with \"-\".'", text("ssh.hostDash", "The host name must not start with \"-\"."), ["ssh.hostDash"]);
    edit("dist/remote/sshDestination.js", "'Write \"@\" inside the user name of an ssh:// URI as %40.'", text("ssh.uriAt", "Write \"@\" inside the user name of an ssh:// URI as %40."), ["ssh.uriAt"]);
    edit("dist/remote/sshDestination.js", "'Write an IPv6 address in an ssh:// URI in brackets, for example ssh://[::1]:2222.'", text("ssh.uriIPv6", "Write an IPv6 address in an ssh:// URI in brackets, for example ssh://[::1]:2222."), ["ssh.uriIPv6"]);
    edit("dist/remote/sshDestination.js", "'Enter an SSH host, for example \"devbox\" or \"user@host:2222\".'", text("ssh.enterHostPort", "Enter an SSH host, for example \"devbox\" or \"user@host:2222\"."), ["ssh.enterHostPort"]);
    edit("dist/remote/sshDestination.js", "'The SSH host must not start with \"-\".'", text("ssh.destinationDash", "The SSH host must not start with \"-\"."), ["ssh.destinationDash"]);
    edit("dist/remote/sshDestination.js", "'The SSH host must not contain spaces or control characters.'", text("ssh.destinationSpaces", "The SSH host must not contain spaces or control characters."), ["ssh.destinationSpaces"]);
    edit("dist/remote/sshDestination.js", "`\"${shown}\" isn't a valid user name.`", format("ssh.userInvalid", "\"{0}\" isn't a valid user name.", "shown"), ["ssh.userInvalid"]);
    edit("dist/remote/sshDestination.js", "`\"${host}\" isn't a valid host name.`", format("ssh.hostInvalid", "\"{0}\" isn't a valid host name.", "host"), ["ssh.hostInvalid"]);
    edit("dist/remote/sshDestination.js", "`Invalid port \"${port}\": use a number from 1 to 65535.`", format("ssh.portInvalid", "Invalid port \"{0}\": use a number from 1 to 65535.", "port"), ["ssh.portInvalid"]);
    edit("dist/remote/sshDestination.js", "`\"${addr}\" isn't a valid IPv6 address. Write an IPv6 address with a port in brackets, for example [::1]:2222.`", format("ssh.ipv6Invalid", "\"{0}\" isn't a valid IPv6 address. Write an IPv6 address with a port in brackets, for example [::1]:2222.", "addr"), ["ssh.ipv6Invalid"]);
    edit("dist/remote/sshDestination.js", "`Missing \"]\" after the IPv6 address in \"${hostPort}\".`", format("ssh.ipv6Bracket", "Missing \"]\" after the IPv6 address in \"{0}\".", "hostPort"), ["ssh.ipv6Bracket"]);
    edit("dist/remote/sshDestination.js", "`Unexpected \"${rest}\" after \"]\".`", format("ssh.ipv6Unexpected", "Unexpected \"{0}\" after \"]\".", "rest"), ["ssh.ipv6Unexpected"]);
    edit("dist/remote/sshDestination.js", "`Invalid percent-encoding in the user name \"${s}\".`", format("ssh.percentInvalid", "Invalid percent-encoding in the user name \"{0}\".", "s"), ["ssh.percentInvalid"]);
    edit("dist/remote/sshDestination.js", "`The SSH host is too long (at most ${MAX_DESTINATION_LENGTH} characters).`", format("ssh.destinationTooLong", "The SSH host is too long (at most {0} characters).", "MAX_DESTINATION_LENGTH"), ["ssh.destinationTooLong"]);
    edit("dist/remote/sshDestination.js", "`The SSH host must not contain ${describeChar(bad[0])}.`", format("ssh.destinationCharacter", "The SSH host must not contain {0}.", "describeChar(bad[0])"), ["ssh.destinationCharacter"]);
    edit("dist/remote/sshConfigHosts.js", "`The SSH config file ${problem}`", format("ssh.configProblem", "The SSH config file {0}", "problem"), ["ssh.configProblem"]);
    edit("dist/remote/sshConfigHosts.js", "'must be a path on one line.'", text("ssh.configOneLine", "must be a path on one line."), ["ssh.configOneLine"]);
    edit("dist/remote/sshConfigHosts.js", "`${shown} isn't a file.`", format("ssh.configNotFile", "{0} isn't a file.", "shown"), ["ssh.configNotFile"]);
    edit("dist/remote/sshConfigHosts.js", "`${shown} can be changed by others: it must be yours or root's, and not group- or world-writable.`", format("ssh.configPermissions", "{0} can be changed by others: it must be yours or root's, and not group- or world-writable.", "shown"), ["ssh.configPermissions"]);
    edit("dist/remote/sshConfigHosts.js", "`must be an absolute path (got ${shown}).`", format("ssh.configAbsolute", "must be an absolute path (got {0}).", "shown"), ["ssh.configAbsolute"]);
    edit("dist/remote/sshConfigHosts.js", "`must be on one of this computer's drives (got ${shown}).`", format("ssh.configLocalDrive", "must be on one of this computer's drives (got {0}).", "shown"), ["ssh.configLocalDrive"]);
    edit("dist/remote/sshConfigHosts.js", "`can't be on a network share (${shown}).`", format("ssh.configNetworkShare", "can't be on a network share ({0}).", "shown"), ["ssh.configNetworkShare"]);
    edit("dist/remote/sshConfigHosts.js", "\n        throw invalid(`${shown} doesn't exist or can't be read.`);", "\n        throw invalid(" + format("ssh.configUnreadable", "{0} doesn't exist or can't be read.", "shown") + ");", ["ssh.configUnreadable"]);
    edit("dist/remote/sshConfigHosts.js", "\n    const unreadable = () => invalid(`${shown} doesn't exist or can't be read.`);", "\n    const unreadable = () => invalid(" + format("ssh.configUnreadable", "{0} doesn't exist or can't be read.", "shown") + ");", ["ssh.configUnreadable"]);
    edit("dist/remote/sshConfigHosts.js", "`${shown} is now a link: choose the file again.`", format("ssh.configChangedToLink", "{0} is now a link: choose the file again.", "shown"), ["ssh.configChangedToLink"]);
    edit("dist/remote/sshConfigHosts.js", "`${shown} is over 4 MiB.`", format("ssh.configTooLarge", "{0} is over 4 MiB.", "shown"), ["ssh.configTooLarge"]);
    if (adapterVersion === '3') edit("dist/remote/sshConnection.js", "\n            throw new types_1.RemoteError('CONNECTION_CLOSED', 'Not connected.');", "\n            throw new types_1.RemoteError('CONNECTION_CLOSED', " + text("ssh.notConnected", "Not connected.") + ");", ["ssh.notConnected"]);
    edit("dist/remote/sshConnection.js", "\n                    throw new types_1.RemoteError('CONNECTION_CLOSED', 'Not connected.');", "\n                    throw new types_1.RemoteError('CONNECTION_CLOSED', " + text("ssh.notConnected", "Not connected.") + ");", ["ssh.notConnected"]);
    edit("dist/remote/sshConnection.js", "'The connection was closed.'", text("ssh.closed", "The connection was closed."), ["ssh.closed"]);
    edit("dist/remote/sshConnection.js", "'Could not get a free loopback port.'", text("ssh.loopbackPortFailed", "Could not get a free loopback port."), ["ssh.loopbackPortFailed"]);
    edit("dist/remote/sshPrompts.js", "\"The ssh prompt window didn't load.\"", text("ssh.promptLoadFailed", "The ssh prompt window didn't load."), ["ssh.promptLoadFailed"]);
  }

  if (adapterVersion === '4') {
    requireAnchor('dist/remote/sshPromptPreload.js', "electron_1.ipcRenderer.once('ssh-prompt:show', (_event, { label, title, message, retry }) => {");
    requireAnchor('dist/remote/sshPromptPreload.js', 'host.textContent = label;\n    heading.textContent = title;\n    text.textContent = message;\n    text.hidden = !message;\n    note.hidden = !retry;');
    edit("dist/remote/remoteManager.js", "\n                    title: 'Stop SSH server'", "\n                    title: " + text("ssh.stopServerTitle", "Stop SSH server"), ["ssh.stopServerTitle"]);
    edit("dist/remote/remoteManager.js", "'Agents running on this host will stop and its window will close. ' +\n                        'The server starts again the next time you connect.'", text("ssh.stopServerDetail", "Agents running on this host will stop and its window will close. The server starts again the next time you connect."), ["ssh.stopServerDetail"]);
    edit("dist/remote/remoteManager.js", "title: 'Sign in',\n            message: `Sign in to your organization for ${entry.label}?`", "title: " + text("ssh.signInTitle", "Sign in") + ",\n            message: " + format("ssh.organizationSignInConfirm", "Sign in to your organization for {0}?", "entry.label"), ["ssh.signInTitle","ssh.organizationSignInConfirm"]);
    edit("dist/remote/remoteManager.js", "title: 'Sign in',\n            message: `Finish this sign-in on ${entry.label}?`", "title: " + text("ssh.signInTitle", "Sign in") + ",\n            message: " + format("ssh.finishSignIn", "Finish this sign-in on {0}?", "entry.label"), ["ssh.finishSignIn","ssh.signInTitle"]);
    edit("dist/remote/remoteManager.js", "`Continue only if you just chose to sign in from the ${entry.label} ` +\n                'window. Your browser opens the sign-in page; once you sign in, ' +\n                `${entry.label} gets access to that account.\\n` +\n                `Sign-in page: ${(0, types_1.sanitizeRemoteText)(new URL(origin).host, 200)}`", format("ssh.finishSignInDetail", "Continue only if you just chose to sign in from the {0} window. Your browser opens the sign-in page; once you sign in, {0} gets access to that account.\nSign-in page: {1}", "entry.label, (0, types_1.sanitizeRemoteText)(new URL(origin).host, 200)"), ["ssh.finishSignInDetail"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Continue', 'Cancel']", "buttons: [" + text("common.continue", "Continue") + ", " + text("common.cancel", "Cancel") + "]", ["common.continue","common.cancel"]);
    edit("dist/remote/sshPrompts.js", "<div id=\"long\" class=\"note\" role=\"alert\" hidden>That's too long.</div>", "<div id=\"long\" class=\"note\" role=\"alert\" hidden>${" + htmlText(text("ssh.promptTooLong", "That's too long.")) + "}</div>", ["ssh.promptTooLong"]);
    edit("dist/remote/sshPrompts.js", "<button id=\"cancel\" class=\"secondary\">Cancel</button>", "<button id=\"cancel\" class=\"secondary\">${" + htmlText(text("common.cancel", "Cancel")) + "}</button>", ["common.cancel"]);
    edit("dist/remote/sshPrompts.js", "<button id=\"continue\" class=\"primary\">Continue</button>", "<button id=\"continue\" class=\"primary\">${" + htmlText(text("common.continue", "Continue")) + "}</button>", ["common.continue"]);
    // Escape the framing before restoring the span; the preload inserts the host as text.
    edit("dist/remote/sshPrompts.js", "<p class=\"context\">Connecting to <span id=\"label\"></span></p>", "<p class=\"context\">${" + htmlText(format("ssh.promptConnectingTo", "Connecting to {0}", "\"AGYCTL_HOST_LABEL\"")) + ".replace(\"AGYCTL_HOST_LABEL\", '<span id=\"label\"></span>')}</p>", ["ssh.promptConnectingTo"]);
    edit("dist/remote/sshPrompts.js", "'Touch your security key'", text("ssh.touchSecurityKey", "Touch your security key"), ["ssh.touchSecurityKey"]);
    edit("dist/remote/sshPrompts.js", "`Trust ${hostName(host.split(' (')[0])}?`", format("ssh.promptTrustHost", "Trust {0}?", "hostName(host.split(' (')[0])"), ["ssh.promptTrustHost"]);
    edit("dist/remote/sshPrompts.js", "`Connect to ${hostName(host)} anyway?`", format("ssh.promptConnectAnyway", "Connect to {0} anyway?", "hostName(host)"), ["ssh.promptConnectAnyway"]);
    edit("dist/remote/sshPrompts.js", "'Accept updated host keys?'", text("ssh.promptAcceptHostKeys", "Accept updated host keys?"), ["ssh.promptAcceptHostKeys"]);
    edit("dist/remote/sshPrompts.js", "`Add ${baseName(key.split(' (')[0])} to ssh-agent?`", format("ssh.promptAddKey", "Add {0} to ssh-agent?", "baseName(key.split(' (')[0])"), ["ssh.promptAddKey"]);
    edit("dist/remote/sshPrompts.js", "`Question from ${who}`", format("ssh.promptQuestion", "Question from {0}", "who"), ["ssh.promptQuestion"]);
    edit("dist/remote/sshPrompts.js", "`Verification code for ${who}`", format("ssh.promptVerification", "Verification code for {0}", "who"), ["ssh.promptVerification"]);
    edit("dist/remote/sshPrompts.js", "`Password for ${who}`", format("ssh.promptPassword", "Password for {0}", "who"), ["ssh.promptPassword"]);
    edit("dist/remote/sshPrompts.js", "`PIN for ${who}`", format("ssh.promptPin", "PIN for {0}", "who"), ["ssh.promptPin"]);
    edit("dist/remote/sshPrompts.js", "`Sign in to ${who}`", format("ssh.promptSignIn", "Sign in to {0}", "who"), ["ssh.promptSignIn"]);
    edit("dist/remote/sshPrompts.js", "'Password'", text("ssh.credentialPassword", "Password"), ["ssh.credentialPassword"]);
    edit("dist/remote/sshPrompts.js", "'Current password'", text("ssh.credentialCurrentPassword", "Current password"), ["ssh.credentialCurrentPassword"]);
    edit("dist/remote/sshPrompts.js", "'New password'", text("ssh.credentialNewPassword", "New password"), ["ssh.credentialNewPassword"]);
    edit("dist/remote/sshPrompts.js", "'Confirm new password'", text("ssh.credentialConfirmPassword", "Confirm new password"), ["ssh.credentialConfirmPassword"]);
    edit("dist/remote/sshPrompts.js", "'Passphrase'", text("ssh.credentialPassphrase", "Passphrase"), ["ssh.credentialPassphrase"]);
    edit("dist/remote/sshPrompts.js", "return ['PIN', what.slice(1, -1)];", "return [" + text("ssh.credentialPin", "PIN") + ", what.slice(1, -1)];", ["ssh.credentialPin"]);
    edit("dist/remote/sshPrompts.js", "['PIN', baseName(what.slice(key + 5))]", "[" + text("ssh.credentialPin", "PIN") + ", baseName(what.slice(key + 5))]", ["ssh.credentialPin"]);
    edit("dist/remote/sshPrompts.js", "`${asked[0]} for ${hostPromptsMarked ? asked[1] : label}`", format("ssh.promptCredentialFor", "{0} for {1}", "asked[0], hostPromptsMarked ? asked[1] : label"), ["ssh.promptCredentialFor"]);
    edit("dist/remote/sshErrorText.js", "`Windows SSH hosts aren't supported yet. ${sshArgs_1.LINUX_HOST_NEEDED}`", format("ssh.windowsHostUnsupported", "Windows SSH hosts aren't supported yet. {0}", "sshArgs_1.LINUX_HOST_NEEDED"), ["ssh.windowsHostUnsupported"]);
    edit("dist/remote/sshArgs.js", "'Antigravity needs a Linux host on x64 or arm64 with glibc 2.26 or newer.'", text("ssh.linuxHostNeeded", "Antigravity needs a Linux host on x64 or arm64 with glibc 2.26 or newer."), ["ssh.linuxHostNeeded"]);
    edit("dist/remote/sshArgs.js", "`The SSH host isn't supported. ${exports.LINUX_HOST_NEEDED} Windows and macOS hosts aren't supported yet.`", format("ssh.unsupportedHostPlatforms", "The SSH host isn't supported. {0} Windows and macOS hosts aren't supported yet.", "exports.LINUX_HOST_NEEDED"), ["ssh.unsupportedHostPlatforms"]);
    edit("dist/remote/sshArgs.js", "'Another host that shares your home directory runs the Antigravity server. Connect to that host, or connect again and choose Take Over.'", text("ssh.sharedHomeTakeOver", "Another host that shares your home directory runs the Antigravity server. Connect to that host, or connect again and choose Take Over."), ["ssh.sharedHomeTakeOver"]);
    edit("dist/remote/sshArgs.js", "\"SSH can't use your SSH config file. Fix the problem ssh reports, or choose another config file.\"", text("ssh.configCannotUse", "SSH can't use your SSH config file. Fix the problem ssh reports, or choose another config file."), ["ssh.configCannotUse"]);
    edit("dist/remote/disconnectedPage.js", "reconnect: 'Reconnect'", "reconnect: " + htmlText(text("ssh.reconnect", "Reconnect")), ["ssh.reconnect"]);
    edit("dist/remote/disconnectedPage.js", "stop: 'Stop Server'", "stop: " + htmlText(text("ssh.stopServerAction", "Stop Server")), ["ssh.stopServerAction"]);
    edit("dist/remote/disconnectedPage.js", "close: 'Close'", "close: " + htmlText(text("ssh.closeWindow", "Close")), ["ssh.closeWindow"]);
    edit("dist/remote/disconnectedPage.js", "`Restarting the Antigravity server on ${host}…`", "escapeHtml(" + format("ssh.restartingServerOn", "Restarting the Antigravity server on {0}…", "page.label") + ")", ["ssh.restartingServerOn"]);
    edit("dist/remote/disconnectedPage.js", "'Restarting…'", "escapeHtml(" + text("ssh.restarting", "Restarting…") + ")", ["ssh.restarting"]);
    edit("dist/remote/disconnectedPage.js", "'This window opens it again once it has started.'", "escapeHtml(" + text("ssh.reopenAfterRestart", "This window opens it again once it has started.") + ")", ["ssh.reopenAfterRestart"]);
    edit("dist/remote/disconnectedPage.js", "`Its server on ${host} stopped, and its agents with it.`", "escapeHtml(" + format("ssh.serverAndAgentsStopped", "Its server on {0} stopped, and its agents with it.", "page.label") + ")", ["ssh.serverAndAgentsStopped"]);
    edit("dist/remote/disconnectedPage.js", "`Its agents on ${host} stopped with it.`", "escapeHtml(" + format("ssh.agentsStoppedWithServer", "Its agents on {0} stopped with it.", "page.label") + ")", ["ssh.agentsStoppedWithServer"]);
    edit("dist/remote/sshConnection.js", "if (!d || !transport || this._state !== 'ready') {\n            throw new types_1.RemoteError('CONNECTION_CLOSED', 'Not connected.');", "if (!d || !transport || this._state !== 'ready') {\n            throw new types_1.RemoteError('CONNECTION_CLOSED', " + text("ssh.notConnected", "Not connected.") + ");", ["ssh.notConnected"]);
    edit("dist/remote/sshConnection.js", "if (!d || !transport || this._state !== 'ready' || d.httpPort === 0) {\n            throw new types_1.RemoteError('CONNECTION_CLOSED', 'Not connected.');", "if (!d || !transport || this._state !== 'ready' || d.httpPort === 0) {\n            throw new types_1.RemoteError('CONNECTION_CLOSED', " + text("ssh.notConnected", "Not connected.") + ");", ["ssh.notConnected"]);
    edit("dist/remote/remoteManager.js", "title: 'Choose another SSH config file'", "title: " + text("ssh.chooseAnotherConfig", "Choose another SSH config file"), ["ssh.chooseAnotherConfig"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Choose Another File…', 'Cancel']", "buttons: [" + text("ssh.chooseAnotherFile", "Choose Another File…") + ", " + text("common.cancel", "Cancel") + "]", ["ssh.chooseAnotherFile","common.cancel"]);
    edit("dist/remote/remoteManager.js", "`${name} can't be the SSH config file`", format("ssh.configFileRefused", "{0} can't be the SSH config file", "name"), ["ssh.configFileRefused"]);
    edit("dist/remote/remoteManager.js", "title: 'Could not restart the SSH server'", "title: " + text("ssh.restartFailedTitle", "Could not restart the SSH server"), ["ssh.restartFailedTitle"]);
    edit("dist/remote/remoteManager.js", "`${entry.label} still runs Antigravity server ${running}.`", format("ssh.stillRunningVersion", "{0} still runs Antigravity server {1}.", "entry.label, running"), ["ssh.stillRunningVersion"]);
    edit("dist/remote/remoteManager.js", "`${entry.label} didn't answer after this computer woke up.`", format("ssh.noAnswerAfterWake", "{0} didn't answer after this computer woke up.", "entry.label"), ["ssh.noAnswerAfterWake"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Allow', \"Don't Allow\"]", "buttons: [" + text("ssh.allowMicrophone", "Allow") + ", " + text("ssh.denyMicrophone", "Don't Allow") + "]", ["ssh.allowMicrophone","ssh.denyMicrophone"]);
    edit("dist/remote/remoteManager.js", "title: 'Microphone access'", "title: " + text("ssh.microphoneAccess", "Microphone access"), ["ssh.microphoneAccess"]);
    edit("dist/remote/remoteManager.js", "`Allow ${label} to use your microphone?`", format("ssh.microphoneConfirm", "Allow {0} to use your microphone?", "label"), ["ssh.microphoneConfirm"]);
    edit("dist/remote/remoteManager.js", "`The page in this window comes from ${label}. If you allow it, that ` +\n                \"host can use this computer's microphone for voice whenever one of \" +\n                'its windows is open. Antigravity asks again after you quit it.'", format("ssh.microphoneDetail", "The page in this window comes from {0}. If you allow it, that host can use this computer's microphone for voice whenever one of its windows is open. Antigravity asks again after you quit it.", "label"), ["ssh.microphoneDetail"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Take Over', 'Cancel']", "buttons: [" + text("ssh.takeOver", "Take Over") + ", " + text("common.cancel", "Cancel") + "]", ["ssh.takeOver","common.cancel"]);
    edit("dist/remote/remoteManager.js", "title: 'Shared home directory'", "title: " + text("ssh.sharedHomeTitle", "Shared home directory"), ["ssh.sharedHomeTitle"]);
    edit("dist/remote/remoteManager.js", "`This window's Antigravity server runs on ${host}, another machine that shares your home directory.`", format("ssh.takeOverOwnServer", "This window's Antigravity server runs on {0}, another machine that shares your home directory.", "host"), ["ssh.takeOverOwnServer"]);
    edit("dist/remote/remoteManager.js", "`Your Antigravity server runs on ${host}, another machine that shares your home directory.`", format("ssh.takeOverLiveServer", "Your Antigravity server runs on {0}, another machine that shares your home directory.", "host"), ["ssh.takeOverLiveServer"]);
    edit("dist/remote/remoteManager.js", "`${host}, another machine that shares your home directory, started your Antigravity server.`", format("ssh.takeOverPreviousServer", "{0}, another machine that shares your home directory, started your Antigravity server.", "host"), ["ssh.takeOverPreviousServer"]);
    edit("dist/remote/remoteManager.js", "`${label} reached ${here} this time. Cancel and reconnect to try again for ${host}, or take over to stop the server on ${host}, and its agents, and run it on ${here} instead.`", format("ssh.takeOverOwnDetail", "{0} reached {1} this time. Cancel and reconnect to try again for {2}, or take over to stop the server on {2}, and its agents, and run it on {1} instead.", "label, here, host"), ["ssh.takeOverOwnDetail"]);
    edit("dist/remote/remoteManager.js", "`${label} reached ${here}. Take over to stop the server on ${host}, and its agents, and run it on ${here} instead. To keep it running, connect to ${host}.`", format("ssh.takeOverLiveDetail", "{0} reached {1}. Take over to stop the server on {2}, and its agents, and run it on {1} instead. To keep it running, connect to {2}.", "label, here, host"), ["ssh.takeOverLiveDetail"]);
    edit("dist/remote/remoteManager.js", "`${label} reached ${here}. Take over only if that server no longer runs, for example if ${host} was shut down or replaced: if it still runs, both servers would write the same files. To check, connect to ${host}.`", format("ssh.takeOverPreviousDetail", "{0} reached {1}. Take over only if that server no longer runs, for example if {2} was shut down or replaced: if it still runs, both servers would write the same files. To check, connect to {2}.", "label, here, host"), ["ssh.takeOverPreviousDetail"]);
    edit("dist/remote/remoteManager.js", "buttons: ['Restart', 'Later']", "buttons: [" + text("ssh.restartAction", "Restart") + ", " + text("ssh.laterAction", "Later") + "]", ["ssh.restartAction","ssh.laterAction"]);
    edit("dist/remote/remoteManager.js", "title: 'Restart SSH server'", "title: " + text("ssh.restartServerTitle", "Restart SSH server"), ["ssh.restartServerTitle"]);
    edit("dist/remote/remoteManager.js", "`${label} is running server ${running}; this app is ${expected}. Restart the server now?`", format("ssh.restartServerConfirm", "{0} is running server {1}; this app is {2}. Restart the server now?", "label, running, expected"), ["ssh.restartServerConfirm"]);
    edit("dist/remote/remoteManager.js", "`Any ${what} still running on it stops. The server starts again with this app's version.`", format("ssh.restartServerDetail", "Any {0} still running on it stops. The server starts again with this app's version.", "what"), ["ssh.restartServerDetail"]);
    edit("dist/remote/remoteManager.js", "'agent or task'", text("ssh.agentsOrTasks", "agent or task"), ["ssh.agentsOrTasks"]);
    edit("dist/remote/remoteManager.js", "'agent, task or terminal'", text("ssh.agentsTasksOrTerminals", "agent, task or terminal"), ["ssh.agentsTasksOrTerminals"]);
    edit("dist/remote/sshConfigHosts.js", "\"isn't an SSH config file\"", text("ssh.configNotSsh", "isn't an SSH config file"), ["ssh.configNotSsh"]);
    edit("dist/remote/sshConfigHosts.js", "'Choose a file of ssh settings, such as ~/.ssh/config.'", text("ssh.configChooseSettings", "Choose a file of ssh settings, such as ~/.ssh/config."), ["ssh.configChooseSettings"]);
    edit("dist/remote/sshConfigHosts.js", "\"is saved in a way ssh can't read\"", text("ssh.configUnreadableEncoding", "is saved in a way ssh can't read"), ["ssh.configUnreadableEncoding"]);
    edit("dist/remote/sshConfigHosts.js", "'Save it as UTF-8 without a byte-order mark.'", text("ssh.configSaveUtf8", "Save it as UTF-8 without a byte-order mark."), ["ssh.configSaveUtf8"]);
    edit("dist/remote/sshConfigHosts.js", "\"it's a binary file\"", text("ssh.configBinary", "it's a binary file"), ["ssh.configBinary"]);
    edit("dist/remote/sshConfigHosts.js", "'it holds a key or certificate'", text("ssh.configKey", "it holds a key or certificate"), ["ssh.configKey"]);
    edit("dist/remote/sshConfigHosts.js", "'it holds SSH public keys, like a .pub or authorized_keys file'", text("ssh.configPublicKeys", "it holds SSH public keys, like a .pub or authorized_keys file"), ["ssh.configPublicKeys"]);
    edit("dist/remote/sshConfigHosts.js", "'it lists SSH host keys, like known_hosts'", text("ssh.configHostKeys", "it lists SSH host keys, like known_hosts"), ["ssh.configHostKeys"]);
    edit("dist/remote/sshConfigHosts.js", "'it starts with a byte-order mark'", text("ssh.configBom", "it starts with a byte-order mark"), ["ssh.configBom"]);
    edit("dist/remote/sshConfigHosts.js", "\"it's saved as UTF-16\"", text("ssh.configUtf16", "it's saved as UTF-16"), ["ssh.configUtf16"]);
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
