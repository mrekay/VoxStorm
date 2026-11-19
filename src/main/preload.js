const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set(['welcome:data', 'welcome:addFolder', 'app:takePendingOpen', 'config:get','config:set', 'config:setIdeState', 'prompt:preview', 'project:add', 'project:remove', 'project:discover', 'project:addPath', 'project:open', 'history:list', 'session:rename','usage:get', 'live:list', 'live:tail', 'live:takeover', 'workflow:state', 'mirror:start', 'usage:history', 'usage:exportCsv', 'usage:plan','pty:spawn', 'fs:list', 'fs:read', 'fs:write', 'fs:create', 'claude:getCleanup', 'claude:setCleanup', 'clipboard:files', 'git:connect', 'update:state', 'update:check', 'update:download', 'update:restart', 'fs:stat', 'fs:mkdir', 'fs:rename', 'fs:trash', 'fs:reveal', 'ide:files', 'ide:search', 'ide:git', 'ide:watch', 'git:head', 'git:sync', 'git:overview', 'git:log', 'git:show', 'git:diff', 'git:stash', 'github:info', 'shell:openGithub',
  'db:list', 'db:save', 'db:delete', 'db:duplicate', 'db:reorder', 'db:test', 'db:connect', 'db:disconnect', 'db:explore', 'db:run', 'db:cancel', 'db:closeTab', 'db:rows', 'db:release', 'db:exportCsv', 'db:analyze', 'db:history', 'db:historyClear', 'db:saved', 'db:savedSave', 'db:savedDelete', 'db:getState', 'db:setState', 'db:scanProjects', 'db:importFound',
  'ssh:list', 'ssh:save', 'ssh:delete', 'ssh:duplicate', 'ssh:reorder', 'ssh:getState', 'ssh:setState', 'ssh:pickKey', 'ssh:connect', 'ssh:disconnect', 'ssh:shell', 'ssh:ls', 'ssh:op', 'ssh:localLs', 'ssh:localOp', 'ssh:transfer', 'ssh:xferCancel', 'ssh:xferAnswer', 'ssh:tunnel', 'ssh:rdp',
  'docker:call', 'docker:logs', 'docker:logsStop', 'docker:term',
  'plugins:list', 'plugins:setEnabled', 'plugins:openDir', 'plugins:remove', 'plugins:addFolder', 'plugins:createSample', 'plugin:storage', 'plugin:fs', 'plugin:shell', 'plugin:stop', 'plugins:log', 'plugins:devSetup', 'plugins:setProjects', 'plugins:addZip', 'plugins:export',
  'win:detached', 'win:detach', 'win:attach', 'win:takeTabs']);
const SEND = new Set(['app:welcome', 'welcome:open', 'welcome:close', 'welcome:min','pty:write', 'pty:resize', 'pty:kill', 'notify', 'tray:update', 'win:min', 'win:max', 'win:close', 'app:quit', 'mirror:input', 'mirror:stop', 'mirror:scroll', 'win:focusMode', 'win:modeMenu', 'ssh:write', 'ssh:resize', 'ssh:closeShell']);
const ON = new Set(['open-project', 'projects-changed','pty:data', 'pty:exit', 'hook', 'focus-tab', 'open-settings', 'config-changed', 'win:state', 'live-sessions', 'address-learned', 'mirror:frame', 'mirror:error', 'mirror:exit', 'update:state', 'ide:fs-changed', 'plugin:shell-out', 'plugins:changed', 'win:detached', 'win:set-mode', 'win:tabs', 'ssh:data', 'ssh:exit', 'ssh:closed', 'ssh:xfer', 'ssh:xferAsk', 'ssh:tunnels', 'docker:log', 'docker:logEnd']);

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('blocked: ' + ch))),
  send: (ch, ...args) => { if (SEND.has(ch)) ipcRenderer.send(ch, ...args); },
  // full path of a file dropped from Windows Explorer (File.path is gone in recent Electron)
  pathForFile: f => { try { return webUtils.getPathForFile(f) || ''; } catch (_) { return ''; } },
  on: (ch, fn) => {
    if (!ON.has(ch)) return () => {};
    const l = (_e, ...args) => fn(...args);
    ipcRenderer.on(ch, l);
    return () => ipcRenderer.removeListener(ch, l);
  },
});
