// Isolated DOM-engine harness. This window never installs an HTTPS interceptor.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const artifactDir = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'));
const INDEX = JSON.parse(fs.readFileSync(path.join(artifactDir, 'index.json'), 'utf8'));
const EXPECTED = {
  'zh-Hant-TW': {
    settings: '開啟設定',
    create: '新增對話',
    placeholder: '隨意提問，用 @ 提及',
    greeting: '嗨 Alice，今天我們要一起完成什麼？',
    customizations: '自訂設定',
    messageInput: '訊息輸入區',
    planType: '輸入',
    planSelect: '並選取',
    pin: '釘選對話',
    projectOptions: '專案選項',
    projectConversation: '在專案中新增對話',
    addProject: '建立新專案',
    projects: '專案清單',
    displayOptions: '顯示選項',
    archive: '封存對話',
    more: '更多選項',
  },
  'zh-Hans-CN': {
    settings: '打开设置',
    create: '新建对话',
    placeholder: '随意提问，用 @ 提及',
    greeting: '嗨 Alice，今天我们要一起完成什么？',
    customizations: '自定义设置',
    messageInput: '消息输入框',
    planType: '输入',
    planSelect: '并选择',
    pin: '置顶对话',
    projectOptions: '项目选项',
    projectConversation: '在项目中新建对话',
    addProject: '创建新项目',
    projects: '项目列表',
    displayOptions: '显示选项',
    archive: '归档对话',
    more: '更多选项',
  },
  'ja-JP': {
    settings: '設定を開く',
    create: '新しい会話',
    placeholder: '何でも質問、@ でメンション',
    greeting: 'こんにちは Alice。今日は何を達成しましょうか？',
    customizations: 'カスタマイズ',
    messageInput: 'メッセージ入力欄',
    planType: '入力：',
    planSelect: '、選択：',
    pin: '会話を固定',
    projectOptions: 'プロジェクトのオプション',
    projectConversation: 'プロジェクトで新しい会話',
    addProject: '新しいプロジェクトを作成',
    projects: 'プロジェクト一覧',
    displayOptions: '表示オプション',
    archive: '会話をアーカイブ',
    more: 'その他のオプション',
  },
}[manifest.locale];
if (!EXPECTED || INDEX.locale !== manifest.locale)
  throw new Error('Unrecognized catalog fixture locale');

const REMOTE_EXPECTED = {
  'zh-Hant-TW': [
    '使用預設值',
    'SSH 主機',
    '正在連線至 user@主機…',
    '位於 Open Settings',
    '已連線至 Open Settings',
    'MCP 錯誤',
    '查看 MCP 伺服器',
    '從此清單隱藏 Open Settings',
    '無法連線至 ',
    '已連線',
  ],
  'zh-Hans-CN': [
    '使用默认值',
    'SSH 主机',
    '正在连接到 user@主機…',
    '位于 Open Settings',
    '已连接到 Open Settings',
    'MCP 错误',
    '查看 MCP 服务器',
    '从此列表隐藏 Open Settings',
    '无法连接到 ',
    '已连接',
  ],
  'ja-JP': [
    '既定値を使用',
    'SSH ホスト',
    'user@主機 に接続中…',
    '接続先: Open Settings',
    'Open Settings に接続しました',
    'MCP エラー',
    'MCP サーバーを表示',
    'この一覧で Open Settings を非表示にする',
    '接続できませんでした: ',
    '接続済み',
  ],
}[manifest.locale];

const PAGE = `<!doctype html>
<html><body>
<nav>
  <button id="settings" title="Open Settings" aria-label="New Conversation">Open Settings</button>
  <button id="create">New Conversation</button>
</nav>
<div data-testid="home-greeting"><h1 id="greeting">Hi Alice, what can we get done today?</h1></div>
<div data-testid="sidebar-split">
  <div data-testid="sidebar-navigation-items">
    <a id="sidebar-create" data-testid="new-conversation-button">New Conversation</a>
    <button data-testid="automations-button">Automations</button>
    <a id="customizations">Customizations</a>
  </div>
  <div data-testid="conversation-list-sidebar">
    <div data-testid="section-header"><div>
      <h2><button><span id="projects">Projects</span></button></h2>
      <button id="display-options" aria-label="Display Options"></button>
      <button id="add-project" data-testid="sidebar-add-project-button" aria-label="Create New Project"></button>
    </div></div>
    <div><button data-testid="project-header" id="project-name" aria-label="Projects">Projects</button></div><div><button id="project-options" aria-label="Project options"></button><a id="project-conversation" aria-label="New Conversation in Project"></a></div>
    <div data-testid="conversation-row-sidebar">
      <a id="conversation-name" role="button" aria-label="More options">More options</a>
      <button id="archive" data-testid="conversation-archive-button" aria-label="Archive conversation"></button>
      <button id="pin" data-testid="conversation-pin-button" aria-label="Pin conversation"></button>
      <button id="kebab" data-testid="conversation-kebab" aria-label="More options"></button>
    </div>
    <button id="unreviewed-sidebar-button" aria-label="More options">Projects</button>
    <div data-testid="planner-response-text"><button id="protected-sidebar-control" data-testid="conversation-kebab" aria-label="More options">Projects</button></div>
  </div>
  <span id="sidebar-user">New Conversation</span>
</div>
<div data-testid="agent-input-box">
  <div id="editor" contenteditable="true" data-lexical-editor="true" role="combobox" aria-label="Message input"></div>
</div>
<div contenteditable="true" aria-label="Message input" id="other-editor">Open Settings</div>
<div role="listbox">
  <div data-testid="project-selector-item" data-project-name="Open Settings">
    <span id="picker-project-name" title="Open Settings">Open Settings</span>
    <button id="picker-project-settings" data-testid="project-selector-item-settings">Open Settings</button>
  </div>
</div>
<button data-testid="project-selector-trigger"><span data-project-icon="folder"></span><span id="selected-project-name" class="truncate">Open Settings</span></button>
<div role="dialog">
  <div data-testid="workspace-customizations-view">
    <button><span id="workspace-skill-name" class="font-medium truncate">Open Settings</span></button>
    <div id="workspace-skill-description" class="line-clamp-2">Open Settings</div>
    <button id="workspace-skill-action">Open Settings</button>
  </div>
  <div data-testid="customizations-installed">
    <div id="installed-skill-row" class="group relative flex items-center rounded-lg" title="Open Settings">
    <button><span id="installed-skill-name" class="font-medium flex-shrink-0">Open Settings</span><span id="installed-skill-path" class="text-muted-foreground truncate" title="Open Settings">Open Settings</span></button>
    <button id="installed-skill-action">Open Settings</button>
    </div>
  </div>
</div>
<div role="dialog" aria-labelledby="doc-title">
  <div id="doc-title">Open Settings</div>
  <div data-testid="doc-row-modal"><p id="doc-content">Open Settings</p></div>
  <button id="doc-action">Open Settings</button>
</div>
<div role="listbox" data-mention-menu>
  <div data-testid="menu-category-row"><span id="mention-category" data-testid="menu-option-label">Open Settings</span></div>
  <div><span id="workflow-name" data-testid="menu-option-label">Open Settings</span><span id="workflow-description" data-testid="menu-option-description">Open Settings</span></div>
</div>
<div data-testid="aux-pane-split"><h1 class="text-xl font-medium text-foreground select-none m-0" id="unapproved-page-heading">Customizations</h1></div>
<input id="prompt" placeholder="Ask anything, @ to mention" value="Open Settings">
<div role="dialog"><div data-testid="progress-update-response-text" id="ai" title="Open Settings">Open Settings</div></div>
<div data-testid="conversation-list"><button id="named">Open Settings</button></div>
<pre><code id="code">Open Settings</code></pre>
<div role="dialog">
  <span id="plan-instruction" aria-label="Type"></span>
  <button id="plain-type" title="Type">Type</button><button id="plain-and-select">and select</button>
  <span id="wrong-plan-instruction">Type<code>/</code> and select<code>other</code></span>
  <div data-testid="planner-response-text"><span id="protected-plan-instruction"></span></div>
</div>
<div role="dialog">
  <div data-testid="ssh-connect-dialog">
    <label id="ssh-label">SSH host</label>
    <input id="ssh-input" data-testid="ssh-connect-host-input" aria-label="SSH host" value="user@主機">
    <button id="ssh-default">Use Default</button>
    <button data-testid="ssh-connect-host-option" title="Open Settings">
      <span class="flex flex-col"><span id="ssh-host">Open Settings</span><span id="ssh-path" title="Open Settings">Open Settings</span></span>
      <span id="ssh-connected">Connected</span>
    </button>
    <button id="ssh-action" data-testid="ssh-connect-host-action" aria-label="Hide Open Settings from this list"></button>
    <span id="ssh-config-path" data-testid="ssh-config-file-name" tabindex="0">Open Settings</span>
    <div data-testid="ssh-connect-error"><div><span id="ssh-error-heading"></span><span class="whitespace-pre-line" id="ssh-raw-error">Open Settings</span></div></div>
    <div data-testid="ssh-connect-progress"><span id="ssh-progress">Connecting to user@主機…</span></div>
    <p id="ssh-no-hosts"></p>
  </div>
  <div data-testid="ssh-host-label"><span id="ssh-current-host">On Open Settings</span></div>
  <div data-testid="ssh-machine-switcher-status"><span id="ssh-switch-status">Connected to Open Settings</span></div>
  <span class="inline-flex rounded-full text-error" title="Open Settings" id="mcp-badge">MCP error</span>
  <div data-testid="mcp-server-row"><span class="font-medium" title="Open Settings" id="mcp-name">Open Settings</span><div class="text-red-500 break-words" id="mcp-raw-error"></div></div>
  <div role="alert" class="agy-callout text-destructive" id="mcp-alert">Open Settings</div>
  <div>
    <div class="border-error/30 bg-error/10"><div class="flex items-center gap-2"><span id="mcp-banner-error">Open Settings</span></div><button id="mcp-view">View MCP servers</button></div>
    <div id="plugin-detail-tabpanel"></div>
  </div>
</div>
</body></html>`;

function finish(kind, payload, code) {
  process.stdout.write(`#${kind} ${JSON.stringify(payload)}\n`, () => app.exit(code));
}

const watchdog = setTimeout(() => {
  finish('FATAL', { message: 'dom-engine harness watchdog fired after 30s' }, 3);
}, 30_000);
watchdog.unref();
app.on('window-all-closed', () => {});

function snapshot(wc) {
  return wc.executeJavaScript(`JSON.stringify({
    settings: document.getElementById('settings') && document.getElementById('settings').textContent,
    create: document.getElementById('create').textContent,
    title: document.getElementById('settings').getAttribute('title'),
    aria: document.getElementById('settings').getAttribute('aria-label'),
    aiTitle: document.getElementById('ai').getAttribute('title'),
    greeting: document.getElementById('greeting').textContent,
    sidebarCreate: document.getElementById('sidebar-create').textContent,
    customizations: document.getElementById('customizations').textContent,
    projects: document.getElementById('projects').textContent,
    displayOptions: document.getElementById('display-options').getAttribute('aria-label'),
    addProject: document.getElementById('add-project').getAttribute('aria-label'),
    archive: document.getElementById('archive').getAttribute('aria-label'),
    pin: document.getElementById('pin').getAttribute('aria-label'),
    kebab: document.getElementById('kebab').getAttribute('aria-label'),
    unreviewedSidebarText: document.getElementById('unreviewed-sidebar-button').textContent,
    unreviewedSidebarAria: document.getElementById('unreviewed-sidebar-button').getAttribute('aria-label'),
    protectedSidebarText: document.getElementById('protected-sidebar-control').textContent,
    protectedSidebarAria: document.getElementById('protected-sidebar-control').getAttribute('aria-label'),
    projectOptions: document.getElementById('project-options').getAttribute('aria-label'),
    projectConversation: document.getElementById('project-conversation').getAttribute('aria-label'),
    projectAria: document.getElementById('project-name').getAttribute('aria-label'),
    conversationAria: document.getElementById('conversation-name').getAttribute('aria-label'),
    projectName: document.getElementById('project-name').textContent,
    conversationName: document.getElementById('conversation-name').textContent,
    sidebarUser: document.getElementById('sidebar-user').textContent,
    editorAria: document.getElementById('editor').getAttribute('aria-label'),
    editorText: document.getElementById('editor').textContent,
    editorRole: document.getElementById('editor').getAttribute('role'),
    editorLexical: document.getElementById('editor').getAttribute('data-lexical-editor'),
    otherEditorAria: document.getElementById('other-editor').getAttribute('aria-label'),
    placeholder: document.getElementById('prompt').getAttribute('placeholder'),
    value: document.getElementById('prompt').value,
    ai: document.getElementById('ai').textContent,
    named: document.getElementById('named').textContent,
    code: document.getElementById('code').textContent,
    planText: [...document.getElementById('plan-instruction').childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.data),
    planCodes: [...document.getElementById('plan-instruction').children].map((node) => node.textContent),
    planAria: document.getElementById('plan-instruction').getAttribute('aria-label'),
    plainType: document.getElementById('plain-type').textContent,
    plainTypeTitle: document.getElementById('plain-type').getAttribute('title'),
    plainSelect: document.getElementById('plain-and-select').textContent,
    wrongPlan: document.getElementById('wrong-plan-instruction').textContent,
    protectedPlan: document.getElementById('protected-plan-instruction').textContent,
    stats: window.__engine ? window.__engine.stats() : null
  })`);
}

function waitFor(wc, expression, label) {
  return wc.executeJavaScript(`(async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (${expression}) return true;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(${JSON.stringify(label)});
  })()`);
}

app
  .whenReady()
  .then(async () => {
    const checks = [];
    const check = (name, pass, detail) => {
      checks.push({ name, pass: Boolean(pass), detail: pass ? undefined : String(detail) });
      return Boolean(pass);
    };
    const bundle = fs.readFileSync(
      path.join(__dirname, '../../../dist/localization/bundle/dom-engine.js'),
      'utf8',
    );
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const wc = win.webContents;
    await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    await wc.executeJavaScript(`(() => {
      const span = document.getElementById('plan-instruction');
      const slash = document.createElement('code');
      slash.textContent = '/';
      const plan = document.createElement('code');
      plan.textContent = 'plan';
      span.replaceChildren(document.createTextNode('Type'), document.createTextNode(' '), slash,
        document.createTextNode(' '), document.createTextNode('and select'), document.createTextNode(' '),
        plan, document.createTextNode(' '), document.createTextNode('Open Settings'));
      document.getElementById('protected-plan-instruction').replaceChildren(...[...span.childNodes].map((node) => node.cloneNode(true)));
      window.__planNodes = [...span.childNodes];
      window.__planClicks = 0;
      slash.addEventListener('click', () => { window.__planClicks += 1; });
      plan.addEventListener('click', () => { window.__planClicks += 1; });
      document.getElementById('ssh-error-heading').replaceChildren(document.createTextNode("Couldn't connect to "), document.createTextNode('Open Settings'));
      document.getElementById('ssh-no-hosts').replaceChildren(document.createTextNode('No hosts in '), document.createTextNode('Open Settings'), document.createTextNode(' yet. Type one above.'));
      document.getElementById('mcp-raw-error').replaceChildren(document.createTextNode('Error: '), document.createTextNode('Open Settings'));
    })()`);
    await wc.executeJavaScript(bundle);
    const started = JSON.parse(
      await wc.executeJavaScript(`
        window.__engine = window.__AGYCTL_DOM_ENGINE__.createDomEngine({
          document,
          index: ${JSON.stringify(INDEX)},
          locale: ${JSON.stringify(manifest.locale)},
        });
        JSON.stringify(window.__engine.start());
      `),
    );
    check('start-ok', started.ok === true, JSON.stringify(started));
    const delayedWin = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const delayed = delayedWin.webContents;
    await delayed.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html><body></body></html>')}`,
    );
    await delayed.executeJavaScript(bundle);
    const delayedStart = JSON.parse(
      await delayed.executeJavaScript(`
        window.__engine = window.__AGYCTL_DOM_ENGINE__.createDomEngine({
          document,
          index: ${JSON.stringify(INDEX)},
          locale: ${JSON.stringify(manifest.locale)},
        });
        JSON.stringify(window.__engine.start());
      `),
    );
    check(
      'delayed-start-observes',
      delayedStart.ok === true && delayedStart.code === 'NO_WRITABLE_ROOT',
      JSON.stringify(delayedStart),
    );
    check(
      'delayed-ready-pending',
      await delayed.executeJavaScript(`(async () => {
      window.__readyResult = null;
      window.__engine.whenWritable().then((result) => { window.__readyResult = result; });
      await Promise.resolve();
      return window.__readyResult === null;
    })()`),
    );
    await delayed.executeJavaScript(`
      const wrapper = document.createElement('div');
      const nav = document.createElement('nav');
      const button = document.createElement('button');
      button.id = 'late';
      button.textContent = 'Open Settings';
      nav.appendChild(button);
      wrapper.appendChild(nav);
      const plain = document.createElement('span');
      plain.id = 'late-plain';
      plain.textContent = 'Open Settings';
      wrapper.appendChild(plain);
      const protectedContent = document.createElement('div');
      protectedContent.setAttribute('data-testid', 'planner-response-text');
      const contentButton = document.createElement('button');
      contentButton.id = 'late-protected';
      contentButton.textContent = 'Open Settings';
      protectedContent.appendChild(contentButton);
      wrapper.appendChild(protectedContent);
      const sidebar = document.createElement('div');
      sidebar.setAttribute('data-testid', 'conversation-list-sidebar');
      sidebar.innerHTML = '<div data-testid="section-header"><div><h2><button><span id="late-projects">Projects</span></button></h2></div></div><div data-testid="project-header"><button id="late-project-name" aria-label="Projects">Projects</button></div>';
      wrapper.appendChild(sidebar);
      document.body.appendChild(wrapper);
    `);
    await waitFor(
      delayed,
      `document.getElementById('late') && document.getElementById('late').textContent === ${JSON.stringify(EXPECTED.settings)} && document.getElementById('late-projects').textContent === ${JSON.stringify(EXPECTED.projects)} && window.__engine.stats().queued === 0`,
      'delayed root did not translate',
    );
    check(
      'delayed-wrapper-keeps-non-ui-and-protected',
      await delayed.executeJavaScript(`
      document.getElementById('late-plain').textContent === 'Open Settings' &&
      document.getElementById('late-protected').textContent === 'Open Settings' &&
      document.getElementById('late-project-name').textContent === 'Projects' &&
      document.getElementById('late-project-name').getAttribute('aria-label') === 'Projects'
    `),
    );
    const ready = await delayed.executeJavaScript('window.__engine.whenWritable()');
    check(
      'delayed-ready-resolves',
      ready.ok === true && ready.code === undefined,
      JSON.stringify(ready),
    );
    const disposedReady = await delayed.executeJavaScript(`(async () => {
      window.__engine.dispose();
      document.body.replaceChildren();
      const engine = window.__AGYCTL_DOM_ENGINE__.createDomEngine({
        document, index: ${JSON.stringify(INDEX)}, locale: ${JSON.stringify(manifest.locale)},
      });
      engine.start();
      const ready = engine.whenWritable();
      engine.dispose();
      const button = document.createElement('button');
      button.textContent = 'Open Settings';
      document.body.appendChild(button);
      return { pending: await ready, subsequent: await engine.whenWritable(), text: button.textContent };
    })()`);
    check(
      'disposed-ready-never-active',
      disposedReady.pending.ok === false &&
        disposedReady.pending.code === 'DISPOSED' &&
        disposedReady.subsequent.code === 'DISPOSED' &&
        disposedReady.text === 'Open Settings',
      JSON.stringify(disposedReady),
    );
    const scanBudget = await delayed.executeJavaScript(`(async () => {
      const sample = document.implementation.createHTMLDocument('');
      sample.body.innerHTML = '<nav>' + '<label><button>Unreviewed UI label</button><button>Open Settings</button></label>'.repeat(40) + '</nav>';
      const jobs = [];
      let ticks = 0;
      const engine = window.__AGYCTL_DOM_ENGINE__.createDomEngine({
        document: sample, index: ${JSON.stringify(INDEX)}, locale: ${JSON.stringify(manifest.locale)},
        budgetMs: 4, now: () => ++ticks,
        schedule: (work) => { jobs.push(work); return jobs.length; }, cancelSchedule: () => {},
      });
      const initial = engine.start().stats;
      let batches = 0;
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const settled = engine.stats();
      const before = settled.scanned;
      const wrapper = sample.createElement('div');
      sample.body.appendChild(wrapper);
      const nav = sample.createElement('nav');
      wrapper.appendChild(nav);
      for (let i = 0; i < 16; i++) {
        const label = sample.createElement('label');
        nav.appendChild(label);
        const button = sample.createElement('button');
        label.appendChild(button);
        button.textContent = 'Unreviewed UI label';
      }
      await Promise.resolve();
      const afterObserver = engine.stats();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const afterMutation = engine.stats();
      const changing = sample.createElement('nav');
      changing.innerHTML = '<button>Open Settings</button>'.repeat(20);
      sample.body.appendChild(changing);
      await Promise.resolve();
      jobs.shift()();
      const replacement = sample.createElement('nav');
      replacement.innerHTML = '<button id="replacement-ui">Open Settings</button><div data-testid="planner-response-text"><button id="replacement-user">Open Settings</button></div>';
      changing.replaceWith(replacement);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const replaced = {
        translated: replacement.querySelector('#replacement-ui').textContent,
        protected: replacement.querySelector('#replacement-user').textContent,
        queued: engine.stats().queued,
      };
      const ai = sample.createElement('div');
      ai.setAttribute('data-testid', 'planner-response-text');
      ai.innerHTML = '<p>Open Settings</p>';
      sample.body.appendChild(ai);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const beforeAI = engine.stats();
      const additions = sample.createDocumentFragment();
      for (let i = 0; i < 2000; i++) {
        const span = sample.createElement('span');
        span.textContent = 'Open Settings';
        additions.appendChild(span);
      }
      ai.appendChild(additions);
      ai.firstChild.firstChild.data = 'New Conversation';
      await Promise.resolve();
      const aiQueued = engine.stats();
      const aiJobs = jobs.length;
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const afterAI = engine.stats();
      const ownedNav = sample.createElement('nav');
      ownedNav.innerHTML = '<button title="Open Settings">Open Settings</button>'.repeat(3);
      const owned = [...ownedNav.children];
      sample.body.appendChild(ownedNav);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      ai.appendChild(owned[0]);
      const ownedWrapper = sample.createElement('div');
      ownedWrapper.appendChild(owned[1]);
      ai.appendChild(ownedWrapper);
      owned[2].remove();
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const disconnected = { text: owned[2].textContent, title: owned[2].title };
      const detachedWrapper = sample.createElement('div');
      detachedWrapper.appendChild(owned[2]);
      ai.appendChild(detachedWrapper);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const restoredOwned = owned.map((button) => ({ text: button.textContent, title: button.title }));
      const dialog = sample.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const planSpan = sample.createElement('span');
      planSpan.innerHTML = 'Type<code>/</code>and select<code>plan</code>';
      const typeNode = planSpan.childNodes[0];
      const selectNode = planSpan.childNodes[2];
      const planCode = planSpan.childNodes[3];
      dialog.appendChild(planSpan);
      sample.body.appendChild(dialog);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const ordinary = sample.createElement('button');
      dialog.appendChild(ordinary);
      const planTransitions = [];
      const changes = [
        () => ordinary.appendChild(typeNode),
        () => planSpan.prepend(typeNode),
        () => { planCode.textContent = 'other'; },
        () => { planCode.textContent = 'plan'; },
        () => planCode.remove(),
        () => planSpan.appendChild(planCode),
      ];
      for (const change of changes) {
        change();
        await Promise.resolve();
        while (jobs.length && batches++ < 10000) jobs.shift()();
        planTransitions.push({ type: typeNode.data, select: selectNode.data, queued: engine.stats().queued });
      }
      ai.appendChild(planSpan);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const beforeReleasedPlan = engine.stats();
      planCode.firstChild.data = 'other';
      await Promise.resolve();
      const releasedPlanJobs = jobs.length;
      const releasedPlanQueued = engine.stats().queued;
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const afterReleasedPlan = engine.stats();
      const lateDocuments = [];
      for (let i = 0; i < 3; i++) {
        const modal = sample.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-labelledby', 'late-document-title-' + i);
        const title = sample.createElement('div');
        title.id = 'late-document-title-' + i;
        title.textContent = 'Open Settings';
        modal.appendChild(title);
        sample.body.appendChild(modal);
        await Promise.resolve();
        while (jobs.length && batches++ < 10000) jobs.shift()();
        const beforeTitle = title.textContent;
        const before = engine.stats();
        const content = sample.createElement('div');
        content.setAttribute('data-testid', 'doc-row-modal');
        content.innerHTML = '<span>Open Settings</span>'.repeat(2000);
        if (i === 2) {
          content.removeAttribute('data-testid');
          content.replaceChildren();
          modal.appendChild(content);
          await Promise.resolve();
          while (jobs.length && batches++ < 10000) jobs.shift()();
          content.setAttribute('data-testid', 'doc-row-modal');
          content.innerHTML = '<span>Open Settings</span>'.repeat(2000);
        }
        else if (i === 0) modal.appendChild(content);
        else { const wrapper = sample.createElement('div'); wrapper.appendChild(content); modal.appendChild(wrapper); }
        await Promise.resolve();
        while (jobs.length && batches++ < 10000) jobs.shift()();
        lateDocuments.push({ beforeTitle, title: title.textContent, contentOriginal: [...content.children].every((node) => node.textContent === 'Open Settings'), scanned: engine.stats().scanned - before.scanned });
      }
      const trigger = sample.createElement('button');
      trigger.setAttribute('data-testid', 'project-selector-trigger');
      trigger.innerHTML = '<span class="truncate">Open Settings</span>';
      sample.body.appendChild(trigger);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const beforeProjectIcon = trigger.textContent;
      const icon = sample.createElement('span');
      icon.setAttribute('data-project-icon', 'folder');
      trigger.prepend(icon);
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const afterProjectIcon = trigger.textContent;
      icon.removeAttribute('data-project-icon');
      trigger.lastElementChild.firstChild.data = 'New Conversation';
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const beforeProjectIconAttribute = trigger.textContent;
      icon.setAttribute('data-project-icon', 'folder');
      await Promise.resolve();
      while (jobs.length && batches++ < 10000) jobs.shift()();
      const afterProjectIconAttribute = trigger.textContent;
      const beforeReleasedAI = engine.stats();
      ai.appendChild(sample.createElement('span')).textContent = 'Open Settings';
      await Promise.resolve();
      const afterReleasedAI = engine.stats();
      engine.dispose();
      return { initial, settled, before, afterObserver, afterMutation, batches, replaced, beforeAI, aiQueued, aiJobs, afterAI, disconnected, restoredOwned, planTransitions, beforeReleasedPlan, afterReleasedPlan, releasedPlanJobs, releasedPlanQueued, lateDocuments, beforeProjectIcon, afterProjectIcon, beforeProjectIconAttribute, afterProjectIconAttribute, beforeReleasedAI, afterReleasedAI };


    })()`);
    check(
      'initial-scan-budgeted-and-ancestor-deduplicated',
      scanBudget.initial.scanned > 0 &&
        scanBudget.initial.scanned <= 4 &&
        scanBudget.settled.unmatched === 40 &&
        scanBudget.settled.translated === 40 &&
        scanBudget.settled.queued === 0,
      JSON.stringify(scanBudget),
    );
    check(
      'observer-defers-and-deduplicates-added-subtrees',
      scanBudget.afterObserver.scanned === scanBudget.before &&
        scanBudget.afterMutation.unmatched - scanBudget.settled.unmatched === 16 &&
        scanBudget.afterMutation.queued === 0 &&
        scanBudget.replaced.translated === EXPECTED.settings &&
        scanBudget.replaced.protected === 'Open Settings' &&
        scanBudget.replaced.queued === 0,
      JSON.stringify(scanBudget),
    );
    check(
      'pure-protected-mutations-do-no-work',
      scanBudget.aiQueued.queued === 0 &&
        scanBudget.aiJobs === 0 &&
        scanBudget.afterAI.scanned === scanBudget.beforeAI.scanned &&
        scanBudget.afterAI.batches === scanBudget.beforeAI.batches &&
        scanBudget.afterAI.translated === scanBudget.beforeAI.translated,
      JSON.stringify(scanBudget),
    );
    check(
      'owned-moves-restore-without-protected-scans',
      scanBudget.disconnected.text === 'Open Settings' &&
        scanBudget.disconnected.title === 'Open Settings' &&
        scanBudget.restoredOwned.every(
          (button) => button.text === 'Open Settings' && button.title === 'Open Settings',
        ),
      JSON.stringify(scanBudget),
    );
    check(
      'released-protected-plan-does-not-schedule',
      scanBudget.releasedPlanJobs === 0 &&
        scanBudget.releasedPlanQueued === 0 &&
        scanBudget.afterReleasedPlan.batches === scanBudget.beforeReleasedPlan.batches &&
        scanBudget.afterReleasedPlan.scanned === scanBudget.beforeReleasedPlan.scanned,
      JSON.stringify(scanBudget),
    );
    check(
      'late-document-protection-restores-owned-label-without-content-scan',
      scanBudget.lateDocuments.every(
        (row) =>
          row.beforeTitle === EXPECTED.settings &&
          row.title === 'Open Settings' &&
          row.contentOriginal &&
          row.scanned <= 2,
      ),
      JSON.stringify(scanBudget.lateDocuments),
    );
    check(
      'late-project-icon-restores-owned-project-name',
      scanBudget.beforeProjectIcon === EXPECTED.settings &&
        scanBudget.afterProjectIcon === 'Open Settings' &&
        scanBudget.beforeProjectIconAttribute === EXPECTED.create &&
        scanBudget.afterProjectIconAttribute === 'New Conversation',
      JSON.stringify([scanBudget.afterProjectIcon, scanBudget.afterProjectIconAttribute]),
    );
    const expectedContexts = [
      [false, true],
      [true, true],
      [false, false],
      [true, true],
      [false, false],
      [true, true],
    ];
    for (const [i, transition] of scanBudget.planTransitions.entries()) {
      const [typeTranslated, selectTranslated] = expectedContexts[i];
      check(
        'plan-context-lifecycle-' + i,
        transition.type === (typeTranslated ? EXPECTED.planType : 'Type') &&
          transition.select === (selectTranslated ? EXPECTED.planSelect : 'and select') &&
          transition.queued === 0,
        JSON.stringify(transition),
      );
    }
    check(
      'released-owned-index-keeps-pure-ai-idle',
      scanBudget.afterReleasedAI.queued === 0 &&
        scanBudget.afterReleasedAI.batches === scanBudget.beforeReleasedAI.batches &&
        scanBudget.afterReleasedAI.scanned === scanBudget.beforeReleasedAI.scanned,
      JSON.stringify(scanBudget.afterReleasedAI),
    );
    delayedWin.destroy();
    await waitFor(
      wc,
      `document.getElementById('settings').textContent === ${JSON.stringify(EXPECTED.settings)} && window.__engine.stats().queued === 0`,
      'initial catalog translation did not settle',
    );
    const afterStart = JSON.parse(await snapshot(wc));
    const userBoundaries = await wc.executeJavaScript(`(() => {
      const text = (id) => document.getElementById(id).textContent;
      return {
        names: ['picker-project-name', 'selected-project-name', 'workspace-skill-name', 'workspace-skill-description', 'installed-skill-name', 'installed-skill-path', 'doc-title', 'doc-content', 'workflow-name', 'workflow-description'].map(text),
        actions: ['picker-project-settings', 'workspace-skill-action', 'installed-skill-action', 'doc-action', 'mention-category'].map(text),
        nameTitle: document.getElementById('picker-project-name').getAttribute('title'),
        pathTitle: document.getElementById('installed-skill-path').getAttribute('title'),
        rowTitle: document.getElementById('installed-skill-row').getAttribute('title'),
        heading: text('unapproved-page-heading'),
      };
    })()`);
    check(
      'project-and-customization-content-protected',
      userBoundaries.names.every((value) => value === 'Open Settings') &&
        userBoundaries.nameTitle === 'Open Settings' &&
        userBoundaries.rowTitle === 'Open Settings' &&
        userBoundaries.pathTitle === 'Open Settings',
      JSON.stringify(userBoundaries),
    );
    check(
      'mixed-user-lists-keep-fixed-actions-translatable',
      userBoundaries.actions.every((value) => value === EXPECTED.settings),
      JSON.stringify(userBoundaries),
    );
    check(
      'page-heading-not-authorized-by-class-alone',
      userBoundaries.heading === 'Customizations',
      userBoundaries.heading,
    );
    check('button-translated', afterStart.settings === EXPECTED.settings, afterStart.settings);
    check('menu-translated', afterStart.create === EXPECTED.create, afterStart.create);
    check('greeting-keeps-name', afterStart.greeting === EXPECTED.greeting, afterStart.greeting);
    const remote = await wc.executeJavaScript(`({
      controls: [document.getElementById('ssh-default').textContent,
        document.getElementById('ssh-label').textContent,
        document.getElementById('ssh-progress').textContent,
        document.getElementById('ssh-current-host').textContent,
        document.getElementById('ssh-switch-status').textContent,
        document.getElementById('mcp-badge').textContent,
        document.getElementById('mcp-view').textContent,
        document.getElementById('ssh-action').getAttribute('aria-label'),
        document.getElementById('ssh-error-heading').firstChild.data,
        document.getElementById('ssh-connected').textContent],
      content: ['ssh-host', 'ssh-path', 'ssh-config-path', 'ssh-raw-error', 'mcp-name', 'mcp-alert', 'mcp-banner-error'].map((id) => document.getElementById(id).textContent),
      errorHost: document.getElementById('ssh-error-heading').lastChild.data,
      configPath: document.getElementById('ssh-no-hosts').childNodes[1].data,
      mcpError: document.getElementById('mcp-raw-error').lastChild.data,
      tooltip: document.getElementById('mcp-badge').getAttribute('title'),
      input: document.getElementById('ssh-input').value,
    })`);
    check(
      'ssh-mcp-controls-translated',
      JSON.stringify(remote.controls) === JSON.stringify(REMOTE_EXPECTED),
      JSON.stringify(remote),
    );
    check(
      'ssh-mcp-opaque-values-kept',
      remote.content.every((text) => text === 'Open Settings') &&
        remote.errorHost === 'Open Settings' &&
        remote.configPath === 'Open Settings' &&
        remote.mcpError === 'Open Settings' &&
        remote.tooltip === 'Open Settings' &&
        remote.input === 'user@主機',
      JSON.stringify(remote),
    );
    check(
      'sidebar-links-translated',
      afterStart.sidebarCreate === EXPECTED.create &&
        afterStart.customizations === EXPECTED.customizations,
      JSON.stringify(afterStart),
    );
    check(
      'sidebar-user-names-protected',
      afterStart.projectName === 'Projects' &&
        afterStart.projectAria === 'Projects' &&
        afterStart.conversationName === 'More options' &&
        afterStart.conversationAria === 'More options' &&
        afterStart.sidebarUser === 'New Conversation',
      JSON.stringify(afterStart),
    );
    check(
      'sidebar-reviewed-controls-translated',
      afterStart.projects === EXPECTED.projects &&
        afterStart.addProject === EXPECTED.addProject &&
        afterStart.displayOptions === EXPECTED.displayOptions &&
        afterStart.archive === EXPECTED.archive &&
        afterStart.pin === EXPECTED.pin &&
        afterStart.kebab === EXPECTED.more &&
        afterStart.projectOptions === EXPECTED.projectOptions &&
        afterStart.projectConversation === EXPECTED.projectConversation,
      JSON.stringify(afterStart),
    );
    check(
      'sidebar-unreviewed-and-protected-stay-original',
      afterStart.unreviewedSidebarText === 'Projects' &&
        afterStart.unreviewedSidebarAria === 'More options' &&
        afterStart.protectedSidebarText === 'Projects' &&
        afterStart.protectedSidebarAria === 'More options',
      JSON.stringify(afterStart),
    );
    check(
      'editor-display-attribute-translated',
      afterStart.editorAria === EXPECTED.messageInput &&
        afterStart.editorText === '' &&
        afterStart.editorRole === 'combobox' &&
        afterStart.editorLexical === 'true',
      JSON.stringify(afterStart),
    );
    check(
      'other-editable-attribute-protected',
      afterStart.otherEditorAria === 'Message input',
      afterStart.otherEditorAria,
    );
    await wc.executeJavaScript(`document.getElementById('editor').textContent = 'Open Settings'`);
    await waitFor(wc, 'window.__engine.stats().queued === 0', 'editor mutation did not settle');
    const editorAfterTyping = JSON.parse(await snapshot(wc));
    check(
      'editor-user-text-protected',
      editorAfterTyping.editorText === 'Open Settings',
      editorAfterTyping.editorText,
    );
    check(
      'placeholder-translated',
      afterStart.placeholder === EXPECTED.placeholder,
      afterStart.placeholder,
    );
    check('title-translated', afterStart.title === EXPECTED.settings, afterStart.title);
    check('aria-label-translated', afterStart.aria === EXPECTED.create, afterStart.aria);
    check(
      'protected-attribute-unchanged',
      afterStart.aiTitle === 'Open Settings',
      afterStart.aiTitle,
    );
    check('input-value-unchanged', afterStart.value === 'Open Settings', afterStart.value);
    check('protected-ai-unchanged', afterStart.ai === 'Open Settings', afterStart.ai);
    check('protected-name-unchanged', afterStart.named === 'Open Settings', afterStart.named);
    check('code-unchanged', afterStart.code === 'Open Settings', afterStart.code);
    check(
      'local-plan-fragments-translated',
      JSON.stringify(afterStart.planText) ===
        JSON.stringify([
          EXPECTED.planType,
          ' ',
          ' ',
          EXPECTED.planSelect,
          ' ',
          ' ',
          EXPECTED.settings,
        ]),
      JSON.stringify(afterStart),
    );
    check(
      'plan-fragments-reject-other-contexts',
      afterStart.plainType === 'Type' &&
        afterStart.plainTypeTitle === 'Type' &&
        afterStart.plainSelect === 'and select' &&
        afterStart.planAria === 'Type' &&
        afterStart.wrongPlan === 'Type/ and selectother' &&
        afterStart.protectedPlan === 'Type / and select plan Open Settings',
      JSON.stringify(afterStart),
    );
    check(
      'plan-node-and-event-identity-preserved',
      await wc.executeJavaScript(`
      const span = document.getElementById('plan-instruction');
      span.children[0].click(); span.children[1].click();
      span.childNodes.length === 9 && [...span.childNodes].every((node, i) => node === window.__planNodes[i]) && span.children[0].textContent === '/' && span.children[1].textContent === 'plan' && window.__planClicks === 2;
    `),
    );
    const translated = afterStart.stats.translated;
    await wc.executeJavaScript(
      `new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(window.__engine.stats())), 0))`,
    );
    const idle = JSON.parse(await snapshot(wc));
    check(
      'self-mutation-idle',
      idle.stats.translated === translated && idle.stats.queued === 0,
      JSON.stringify(idle.stats),
    );
    await wc.executeJavaScript(`
      document.getElementById('settings').setAttribute('title', 'New Conversation');
      document.getElementById('settings').setAttribute('aria-label', 'Open Settings');
      document.getElementById('prompt').setAttribute('placeholder', 'Open Settings');
      document.getElementById('editor').setAttribute('aria-label', 'Open Settings');
    `);
    await waitFor(
      wc,
      `document.getElementById('settings').getAttribute('title') === ${JSON.stringify(EXPECTED.create)} && document.getElementById('settings').getAttribute('aria-label') === ${JSON.stringify(EXPECTED.settings)} && document.getElementById('prompt').getAttribute('placeholder') === ${JSON.stringify(EXPECTED.settings)}`,
      'attribute mutation did not retranslate',
    );
    const attributes = JSON.parse(await snapshot(wc));
    check(
      'attribute-mutation-translated',
      attributes.title === EXPECTED.create &&
        attributes.aria === EXPECTED.settings &&
        attributes.placeholder === EXPECTED.settings &&
        attributes.editorAria === EXPECTED.settings &&
        attributes.editorText === 'Open Settings',
      JSON.stringify(attributes),
    );
    await wc.executeJavaScript(
      `document.getElementById('create').textContent = 'New Conversation'`,
    );
    await waitFor(
      wc,
      `document.getElementById('create').textContent === ${JSON.stringify(EXPECTED.create)}`,
      'rewrite did not retranslate',
    );
    const redrawn = JSON.parse(await snapshot(wc));
    check('react-rewrite-retranslates', redrawn.create === EXPECTED.create, redrawn.create);
    await wc.executeJavaScript(`
      document.getElementById('project-name').appendChild(document.getElementById('archive'));
      document.querySelector('[data-testid="conversation-list"]')
        .appendChild(document.getElementById('settings'));
    `);
    await waitFor(
      wc,
      `document.getElementById('settings').textContent === 'Open Settings'`,
      'protected move did not restore',
    );
    const moved = JSON.parse(await snapshot(wc));
    check(
      'move-into-protected-restores',
      moved.settings === 'Open Settings' &&
        moved.title === 'New Conversation' &&
        moved.aria === 'Open Settings' &&
        moved.archive === 'Archive conversation' &&
        moved.projectAria === 'Projects' &&
        moved.conversationAria === 'More options',
      JSON.stringify(moved),
    );
    const duplicate = JSON.parse(
      await wc.executeJavaScript(`JSON.stringify(window.__engine.start())`),
    );
    check('duplicate-start', duplicate.code === 'ALREADY_STARTED', JSON.stringify(duplicate));
    await wc.executeJavaScript(`window.__engine.dispose()`);
    const restored = JSON.parse(await snapshot(wc));
    check('dispose-restores-owned', restored.create === 'New Conversation', restored.create);
    check('dispose-restores-placeholder', restored.placeholder === 'Open Settings');
    check('dispose-keeps-protected', restored.ai === 'Open Settings', restored.ai);
    check(
      'dispose-restores-plan-fragments',
      JSON.stringify(restored.planText) ===
        JSON.stringify(['Type', ' ', ' ', 'and select', ' ', ' ', 'Open Settings']),
      JSON.stringify(restored.planText),
    );
    check(
      'dispose-editor-restores-only-attribute',
      restored.editorAria === 'Open Settings' && restored.editorText === 'Open Settings',
      JSON.stringify(restored),
    );
    win.destroy();
    finish(
      'RESULT',
      {
        ok: checks.every((entry) => entry.pass),
        name: 'dom-engine',
        locale: manifest.locale,
        checks,
        electronVersion: process.versions.electron,
      },
      checks.every((entry) => entry.pass) ? 0 : 2,
    );
  })
  .catch((error) => {
    finish('FATAL', { message: String(error?.stack ?? error) }, 3);
  });
