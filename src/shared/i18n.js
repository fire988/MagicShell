/*
 * MagicShell 国际化：主进程与渲染层共用一份字典。
 * - 主进程：const { t, setLocale } = require('./shared/i18n')
 * - 渲染层：<script src="../shared/i18n.js"></script> 后使用 window.I18n
 *
 * 文案值可以是字符串（支持 {name} 占位）或函数（用于英文单复数等需要计算的场合）。
 * 键名按区域分组：app / group / toolbar / sidebar / pane / menu.* / layout / palette / hist / drawer / look / cwd / boot / main
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.I18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const zhCN = {
    // ---------------------------------------------------------------- 应用/通用
    'app.tagline': '分组式终端工作台',
    'app.ungrouped': '未分组',
    'app.close': '关闭',
    'app.title': 'MagicShell',
    'app.langName': '简体中文',

    // ------------------------------------------------------------------- 分组
    'group.default': '默认分组',
    'group.auto': '分组 {n}',
    'group.paneCount': '{n} 个终端',
    'group.new': '新建分组',
    'group.newTitle': '新建分组（Ctrl+Shift+T）',
    'group.empty': '还没有终端',
    'group.emptyHint': '新建一个分组，组内可以并排开多个 PowerShell 窗口。',
    'group.create': '＋ 新建分组',
    'group.rename': '重命名分组',
    'group.copyAll': '复制组内全部终端文本',
    'group.copyDone': '已复制 {n} 个终端的全部文本',
    'group.copyEmpty': '该分组没有可复制的内容',
    'group.close': '关闭分组',
    'group.menu.newPane': '在此分组新建终端',
    'group.startAll': '启动整组',
    'group.stopAll': '停止整组',
    'group.startAllTitle': '启动该组里所有已停止的终端',
    'group.stopAllTitle': '停掉该组的终端进程，窗口保留（释放内存）',
    'group.startedToast': '已启动 {n} 个终端',
    'group.stoppedToast': '已停止 {n} 个终端，窗口仍然保留',
    'group.alreadyStopped': '这组的终端都已经停了',
    'group.pin': '置顶当前分组',
    'group.unpin': '取消置顶',
    'group.pinnedToast': '当前分组已置顶',
    'group.unpinnedToast': '已取消置顶',

    // ----------------------------------------------------------------- 工具栏
    'toolbar.arrange': '排列',
    'toolbar.arrangeTitle': '自动排列当前分组的终端',
    'toolbar.pin': '置顶',
    'toolbar.pinned': '已置顶',
    'toolbar.pinTitle': '将当前分组置顶（窗口始终在最前）',
    'toolbar.addPane': '＋ 终端',
    'toolbar.addPaneTitle': '在当前分组新开终端（Ctrl+T）',
    'toolbar.background': '背景色',
    'toolbar.backgroundTitle': '切换背景色',
    'toolbar.settings': '设置',
    'toolbar.collapse': '收起侧栏',
    'toolbar.collapseTitle': '收起侧边栏（Ctrl+B）',
    'toolbar.expand': '展开侧栏',
    'toolbar.expandTitle': '展开侧边栏（Ctrl+B）',

    // ---------------------------------------------------------------- 侧边栏
    'sidebar.groups': '分组',
    'sidebar.newTerminal': '新建终端',
    'sidebar.kbdCopyAll': '复制全部',
    'sidebar.kbdHistBack': '目录回退',
    'sidebar.kbdUp': '上一级',
    'sidebar.kbdCollapse': '收起侧栏',
    'sidebar.resizeAria': '调整侧边栏宽度',
    'sidebar.resizeHint': '拖动调整宽度 · 双击复位',
    'sidebar.collapsedToast': '侧边栏已收起 · Ctrl+B 展开',
    'sidebar.expandedToast': '侧边栏已展开',
    'sidebar.widthReset': '侧边栏宽度已复位',

    // ----------------------------------------------------------------- 终端窗
    'pane.renameTip': '双击重命名此终端',
    'pane.copyAll': '复制全部',
    'pane.copyAllTitle': '复制全部文本（Ctrl+Shift+A）',
    'pane.pinTitle': '置顶当前分组',
    'pane.more': '更多',
    'pane.dragHint': '拖动标题栏移动窗口',
    'pane.dblRenameHint': '双击重命名',
    'pane.startDir': '启动目录：{dir}',
    'pane.startDirBad': '启动目录不存在：{bad}，已改用 {cwd}',
    'pane.exited': '终端已退出',
    'pane.exitedCode': '终端已退出（代码 {code}）',
    'pane.restart': '重新启动',
    'pane.stop': '停止此终端',
    'pane.start': '启动此终端',
    'pane.startBtn': '启动',
    'pane.stopped': '已停止',
    'pane.stoppedBanner': (v) => (v && v.time ? `已停止 · ${v.time}` : '已停止'),
    'pane.stoppedHint': '在终端里直接输入会自动启动',
    'pane.close': '关闭',
    'pane.startFailed': '启动失败：{reason}',
    'pane.deadLine': '[进程已退出]',
    'pane.deadLineCode': '[进程已退出，代码 {code}]',
    'pane.renamed': '标题已改为「{title}」',
    'pane.renameReset': '已恢复自动标题',
    'pane.copyEmpty': '当前终端没有可复制的文本',
    'pane.copyDone': '已复制全部文本 · {lines} 行 / {chars} 字符',
    'pane.copySelDone': '已复制选中内容',
    'pane.xtermMissing': 'xterm.js 未加载：请检查 node_modules/@xterm 是否安装完整。',
    'pane.ptyDead': 'PTY 不可用',
    'pane.ptyDeadNote': 'PTY 模块不可用，终端无法启动',

    // --------------------------------------------------- 命令块（shell 集成）
    'cmd.okTitle': '上一条命令成功 · 用时 {time}',
    'cmd.failTitle': '上一条命令失败 · 退出码 {code} · 用时 {time}',
    'cmd.copyOutput': '复制这条命令的输出',
    'cmd.copyDone': '已复制这条命令的输出 · {lines} 行',
    'cmd.copyEmpty': '这条命令没有输出',
    'cmd.noCommands': '这个终端还没跑过命令',
    'cmd.jumpFirst': '已经是最早的一条命令了',
    'cmd.jumpLast': '已经是最新的一条命令了',
    'cmd.badgeNew': '上一条命令还没结束',

    // ----------------------------------------------------------- 终端右键菜单
    'menu.pane.rename': '重命名此终端…',
    'menu.pane.renameHint': '双击标题',
    'menu.pane.restoreTitle': '恢复自动标题',
    'menu.pane.startDir': '启动目录…',
    'menu.pane.startDirDefault': '默认',
    'menu.pane.newHere': '在此目录新开终端',
    'menu.pane.parent': '回到上一级目录',
    'menu.pane.parentTitle': '等于在当前终端执行 cd ..',
    'menu.pane.histBack': '目录历史后退',
    'menu.pane.histBackTitle': '回到上次 cd 之前的目录（可以一直往前退）',
    'menu.pane.histForward': '目录历史前进',
    'menu.pane.histForwardTitle': '后退多了就用它往回走',
    'menu.pane.bg': '此终端背景色',
    'menu.pane.bgFollow': '跟随默认',
    'menu.pane.bgSet': '此终端背景：{label}',
    'menu.pane.bgReset': '此终端已跟随默认背景',
    'menu.pane.look': '终端外观…',
    'menu.pane.lookHint': '文字色 / 应用到全部',
    'menu.pane.copyAll': '复制全部文本',
    'menu.pane.copyOutput': '复制这条命令的输出',
    'menu.pane.copySel': '复制选中内容',
    'menu.pane.jumpPrev': '上一条命令',
    'menu.pane.jumpNext': '下一条命令',
    'menu.pane.paste': '粘贴',
    'menu.pane.clear': '清屏',
    'menu.pane.restart': '重新启动',
    'menu.pane.close': '关闭此终端',

    // ----------------------------------------------------------------- 布局
    'layout.auto': '自动（按终端数量）',
    'layout.cols': '左右并排',
    'layout.rows': '上下排列',
    'layout.grid2': '两列网格',
    'layout.grid3': '三列网格',
    'layout.mainLeft': '左大窗 + 右侧堆叠',
    'layout.mainTop': '上方大窗 + 下方并排',
    'layout.custom': '自定义（手动摆放）',
    'layout.customToast': '当前是手动摆放的布局 · 已记住，下次启动照原样恢复',
    'layout.applied': '已排列 {n} 个终端 · {name}',
    'layout.appliedAll': '全部分组共 {n} 个终端已按「{name}」排列',
    'layout.restoreAuto': '当前分组恢复自动排列',
    'layout.allAuto': '所有分组改回自动排列',
    'layout.applyAll': '此布局应用到全部分组',
    'layout.customOnly': '手动布局仅本组',
    'layout.note': '布局会自动记住，下次启动按原样恢复',

    // ------------------------------------------------------------- 配色预设名
    'palette.deepSpace': '深空',
    'palette.pureBlack': '纯黑',
    'palette.midnight': '午夜蓝',
    'palette.inkGreen': '墨绿',
    'palette.charcoal': '炭灰',
    'palette.violetNight': '紫夜',
    'palette.warmWhite': '暖白',
    'palette.paper': '纸白',
    'palette.sky': '天青',

    // ----------------------------------------------------------- 目录历史相关
    'hist.empty': '这个终端还没有目录历史',
    'hist.oldest': '已经是最早的目录了',
    'hist.newest': '已经是最新的目录了',
    'hist.notRunning': '这个终端没在运行',
    'hist.untracked': '这个终端跟踪不到目录（cmd 没有目录钩子）',
    'hist.atRoot': '已经在盘符根目录了',
    'hist.back': '← 回退：{path}',
    'hist.forward': '→ 前进：{path}',
    'hist.parent': '↑ 上一级：{path}',
    'hist.parentOnly': '↑ 上一级目录',
    'hist.failed': '没能切过去：目录可能已被删除或改名',
    'hist.header': '目录历史',
    'hist.none': '还没有切换过目录',
    'hist.cmdNoHook': 'cmd 跟踪不到目录',

    // ------------------------------------------------------------ 设置抽屉
    'drawer.title': '外观与终端',
    'drawer.presets': '预设配色',
    'drawer.windowBg': '窗口背景色',
    'drawer.windowBgNote': '只改窗口界面；单个终端可单独配色。',
    'drawer.paneFollow': '全部终端跟随窗口',
    'drawer.textColor': '文字颜色',
    'drawer.fontSize': '字号',
    'drawer.fontSizeToast': '字号 {n}px',
    'drawer.font': '字体',
    'drawer.fontSarasa': '更纱黑体（中文等宽）',
    'drawer.fontYahei': '微软雅黑',
    'drawer.defaultShell': '默认 Shell',
    'drawer.shellAuto': '自动（优先 PowerShell 7）',
    'drawer.shellCmd': '命令提示符 (cmd)',
    'drawer.shellUpdated': '默认 Shell 已更新，新开的终端生效',
    'drawer.startDir': '默认启动目录',
    'drawer.startDirNote': '新终端默认打开这里；单个终端可在它的「⋯ → 启动目录」里单独指定。',
    'drawer.startDirPlaceholder': '留空 = 用户主目录',
    'drawer.startDirHome': '新终端将打开用户主目录',
    'drawer.startDirSet': '新终端默认打开：{path}',
    'drawer.startDirBad': '目录不存在，请重新填写',
    'drawer.clear': '清除',
    'drawer.browse': '浏览…',
    'drawer.cursorBlink': '光标闪烁',
    'drawer.restore': '启动时恢复上次的分组与布局',
    'drawer.restoreTitle': '分组、每个终端的位置与大小、窗口尺寸/最大化状态都会记住',
    'drawer.notify': '命令跑完提醒',
    'drawer.notifyTitle': '超过 3 秒的命令结束时，如果窗口不在前台就弹通知并闪任务栏',
    'drawer.reset': '恢复默认',
    'drawer.language': '语言',
    'drawer.langAuto': '跟随系统',
    'drawer.langToast': '界面语言已切换为{name}',
    'drawer.paneBgLeft': '终端仍在用自定义背景，可点「全部终端跟随窗口」',

    // ------------------------------------------------------- 终端外观弹层
    'look.title': '终端外观',
    'look.bg': '背景色',
    'look.customBg': '自定义背景',
    'look.auto': '自动',
    'look.autoTitle': '按背景亮度自动选择高对比文字色',
    'look.applyAllTitle': '把当前配色复制到所有分组的所有终端，并作为新终端默认',
    'look.autoContrast': '自动对比',
    'look.custom': '自定义',
    'look.preview': '预览',
    'look.previewTag': '// 预览',
    'look.applyAll': '应用到所有终端',
    'look.done': '完成',
    'look.default': '默认',
    'look.appliedAll': '已应用到全部 {n} 个终端',
    'look.followWindow': '全部终端已跟随窗口背景',
    'look.resetDone': '已恢复默认外观',

    // ------------------------------------------------------- 启动目录弹层
    'cwd.title': '启动目录',
    'cwd.note': '这个终端启动时打开的位置',
    'cwd.current': '当前所在目录',
    'cwd.useThis': '用这个',
    'cwd.recent': '最近使用',
    'cwd.save': '保存',
    'cwd.saveRestart': '保存并重启',
    'cwd.reset': '跟随默认启动目录',
    'cwd.resetLabel': '恢复默认',
    'cwd.home': '主目录',
    'cwd.defaultDir': '默认目录',
    'cwd.noRecent': '还没有记录',
    'cwd.placeholder': '留空 = 跟随默认启动目录 {dir}',
    'cwd.placeholderHome': '留空 = 用户主目录',
    'cwd.livePending': '（shell 还没报告，稍等一秒）',
    'cwd.ok': '✓ 目录存在：{path}',
    'cwd.notFolder': '这不是一个文件夹，请选目录',
    'cwd.notExist': '目录不存在（保存时会拦住你）',
    'cwd.pickNotFolder': '这不是文件夹，请重新选择',
    'cwd.pickNotExist': '目录不存在，请先选一个有效目录',
    'cwd.restarted': '已重启终端',
    'cwd.savedPending': '启动目录已保存，重启该终端后生效',
    'cwd.saved': '启动目录已保存',
    'cwd.resetDone': '已恢复为默认启动目录',

    // ---------------------------------------------------------------- 启动
    'boot.restored': '已恢复上次布局 · {groups} 个分组 / {panes} 个终端',
    'boot.xtermMissing': 'xterm.js 未加载：请检查 node_modules/@xterm 是否安装完整。',

    // -------------------------------------------------------------- 主进程
    'main.pickDirTitle': '选择启动目录',
    'main.pickDirButton': '使用此目录',
    'main.spawnFailed': '启动 {shell} 失败：{reason}',
    'main.ptyLoadFailed': 'pty 模块未加载：请先完成 npm install（需要 node-pty 或预编译版本）',

    // ---------------------------------------------------------- 命令跑完通知
    'notify.doneTitle': '命令跑完了',
    'notify.doneBody': (v) => `${v.title} · ${v.exit === 0 ? '成功' : '退出码 ' + v.exit} · 用时 ${v.time}`,
  };

  const enUS = {
    'app.tagline': 'Grouped terminal workspace',
    'app.ungrouped': 'Ungrouped',
    'app.close': 'Close',
    'app.title': 'MagicShell',
    'app.langName': 'English',

    'group.default': 'Default group',
    'group.auto': 'Group {n}',
    'group.paneCount': (v) => (v.n === 1 ? '1 terminal' : `${v.n} terminals`),
    'group.new': 'New group',
    'group.newTitle': 'New group (Ctrl+Shift+T)',
    'group.empty': 'No terminals yet',
    'group.emptyHint': 'Create a group and run several shells side by side.',
    'group.create': '+ New group',
    'group.rename': 'Rename group',
    'group.copyAll': 'Copy text from all terminals',
    'group.copyDone': (v) => (v.n === 1 ? 'Copied text from 1 terminal' : `Copied text from ${v.n} terminals`),
    'group.copyEmpty': 'Nothing to copy in this group',
    'group.close': 'Close group',
    'group.menu.newPane': 'New terminal in this group',
    'group.startAll': 'Start all',
    'group.stopAll': 'Stop all',
    'group.startAllTitle': 'Start every stopped terminal in this group',
    'group.stopAllTitle': 'Stop the shells in this group but keep their windows (frees memory)',
    'group.startedToast': (v) => (v.n === 1 ? 'Started 1 terminal' : `Started ${v.n} terminals`),
    'group.stoppedToast': (v) => (v.n === 1 ? 'Stopped 1 terminal, window kept' : `Stopped ${v.n} terminals, windows kept`),
    'group.alreadyStopped': 'Every terminal in this group is already stopped',
    'group.pin': 'Pin this group',
    'group.unpin': 'Unpin',
    'group.pinnedToast': 'Group pinned on top',
    'group.unpinnedToast': 'Group unpinned',

    'toolbar.arrange': 'Arrange',
    'toolbar.arrangeTitle': 'Auto-arrange terminals in this group',
    'toolbar.pin': 'Pin',
    'toolbar.pinned': 'Pinned',
    'toolbar.pinTitle': 'Keep this group always on top',
    'toolbar.addPane': '+ Terminal',
    'toolbar.addPaneTitle': 'New terminal in this group (Ctrl+T)',
    'toolbar.background': 'Background',
    'toolbar.backgroundTitle': 'Change background color',
    'toolbar.settings': 'Settings',
    'toolbar.collapse': 'Collapse sidebar',
    'toolbar.collapseTitle': 'Collapse sidebar (Ctrl+B)',
    'toolbar.expand': 'Expand sidebar',
    'toolbar.expandTitle': 'Expand sidebar (Ctrl+B)',

    'sidebar.groups': 'Groups',
    'sidebar.newTerminal': 'New terminal',
    'sidebar.kbdCopyAll': 'Copy all',
    'sidebar.kbdHistBack': 'Dir back',
    'sidebar.kbdUp': 'Up',
    'sidebar.kbdCollapse': 'Collapse',
    'sidebar.resizeAria': 'Resize sidebar',
    'sidebar.resizeHint': 'Drag to resize · double-click to reset',
    'sidebar.collapsedToast': 'Sidebar collapsed · Ctrl+B to expand',
    'sidebar.expandedToast': 'Sidebar expanded',
    'sidebar.widthReset': 'Sidebar width reset',

    'pane.renameTip': 'Double-click to rename this terminal',
    'pane.copyAll': 'Copy all',
    'pane.copyAllTitle': 'Copy all text (Ctrl+Shift+A)',
    'pane.pinTitle': 'Pin this group',
    'pane.more': 'More',
    'pane.dragHint': 'Drag the title bar to move',
    'pane.dblRenameHint': 'Double-click to rename',
    'pane.startDir': 'Start dir: {dir}',
    'pane.startDirBad': 'Start directory not found: {bad}. Using {cwd}',
    'pane.exited': 'Terminal exited',
    'pane.exitedCode': 'Terminal exited (code {code})',
    'pane.restart': 'Restart',
    'pane.stop': 'Stop this terminal',
    'pane.start': 'Start this terminal',
    'pane.startBtn': 'Start',
    'pane.stopped': 'Stopped',
    'pane.stoppedBanner': (v) => (v && v.time ? `Stopped · ${v.time}` : 'Stopped'),
    'pane.stoppedHint': 'Start typing in the terminal to launch it again',
    'pane.close': 'Close',
    'pane.startFailed': 'Failed to start: {reason}',
    'pane.deadLine': '[process exited]',
    'pane.deadLineCode': '[process exited with code {code}]',
    'pane.renamed': 'Title set to “{title}”',
    'pane.renameReset': 'Restored automatic title',
    'pane.copyEmpty': 'No text to copy in this terminal',
    'pane.copyDone': (v) => `Copied all text · ${v.lines} lines / ${v.chars} chars`,
    'pane.copySelDone': 'Copied selection',
    'pane.xtermMissing': 'xterm.js failed to load: check that node_modules/@xterm is installed.',
    'pane.ptyDead': 'PTY unavailable',
    'pane.ptyDeadNote': 'The PTY module is unavailable, so terminals cannot start',

    'cmd.okTitle': (v) => `Last command succeeded · ${v.time}`,
    'cmd.failTitle': (v) => `Last command failed · exit ${v.code} · ${v.time}`,
    'cmd.copyOutput': 'Copy this command’s output',
    'cmd.copyDone': (v) => `Copied output · ${v.lines} line${v.lines === 1 ? '' : 's'}`,
    'cmd.copyEmpty': 'This command produced no output',
    'cmd.noCommands': 'No commands have run in this terminal yet',
    'cmd.jumpFirst': 'Already at the earliest command',
    'cmd.jumpLast': 'Already at the latest command',
    'cmd.badgeNew': 'The last command is still running',

    'menu.pane.rename': 'Rename terminal…',
    'menu.pane.renameHint': 'Double-click title',
    'menu.pane.restoreTitle': 'Restore automatic title',
    'menu.pane.startDir': 'Start directory…',
    'menu.pane.startDirDefault': 'Default',
    'menu.pane.newHere': 'New terminal in this directory',
    'menu.pane.parent': 'Go to parent directory',
    'menu.pane.parentTitle': 'Same as running cd .. in this terminal',
    'menu.pane.histBack': 'Directory history: back',
    'menu.pane.histBackTitle': 'Go back to the previous directory (repeatable)',
    'menu.pane.histForward': 'Directory history: forward',
    'menu.pane.histForwardTitle': 'Go forward again after going back',
    'menu.pane.bg': 'Terminal background',
    'menu.pane.bgFollow': 'Follow default',
    'menu.pane.bgSet': 'Background: {label}',
    'menu.pane.bgReset': 'Following the default background',
    'menu.pane.look': 'Terminal appearance…',
    'menu.pane.lookHint': 'Text color / apply to all',
    'menu.pane.copyAll': 'Copy all text',
    'menu.pane.copyOutput': 'Copy this command’s output',
    'menu.pane.copySel': 'Copy selection',
    'menu.pane.jumpPrev': 'Previous command',
    'menu.pane.jumpNext': 'Next command',
    'menu.pane.paste': 'Paste',
    'menu.pane.clear': 'Clear screen',
    'menu.pane.restart': 'Restart',
    'menu.pane.close': 'Close this terminal',

    'layout.auto': 'Auto (by terminal count)',
    'layout.cols': 'Side by side',
    'layout.rows': 'Stacked',
    'layout.grid2': 'Two-column grid',
    'layout.grid3': 'Three-column grid',
    'layout.mainLeft': 'Big left + stacked right',
    'layout.mainTop': 'Big top + side by side',
    'layout.custom': 'Custom (manual)',
    'layout.customToast': 'Custom layout · remembered and restored on startup',
    'layout.applied': (v) => `Arranged ${v.n} terminal${v.n === 1 ? '' : 's'} · ${v.name}`,
    'layout.appliedAll': (v) => `Arranged ${v.n} terminals in all groups · ${v.name}`,
    'layout.restoreAuto': 'Restore auto layout for this group',
    'layout.allAuto': 'All groups back to auto',
    'layout.applyAll': 'Apply this layout to all groups',
    'layout.customOnly': 'Manual layout stays in this group',
    'layout.note': 'Layout is remembered and restored on startup',

    'palette.deepSpace': 'Deep space',
    'palette.pureBlack': 'Pure black',
    'palette.midnight': 'Midnight blue',
    'palette.inkGreen': 'Ink green',
    'palette.charcoal': 'Charcoal',
    'palette.violetNight': 'Violet night',
    'palette.warmWhite': 'Warm white',
    'palette.paper': 'Paper white',
    'palette.sky': 'Sky blue',

    'hist.empty': 'No directory history for this terminal yet',
    'hist.oldest': 'Already at the oldest directory',
    'hist.newest': 'Already at the newest directory',
    'hist.notRunning': 'This terminal is not running',
    'hist.untracked': 'Cannot track directories here (cmd has no hook)',
    'hist.atRoot': 'Already at the drive root',
    'hist.back': '← Back: {path}',
    'hist.forward': '→ Forward: {path}',
    'hist.parent': '↑ Up: {path}',
    'hist.parentOnly': '↑ Parent directory',
    'hist.failed': 'Could not switch: the directory may be gone or renamed',
    'hist.header': 'Directory history',
    'hist.none': 'No directory changes yet',
    'hist.cmdNoHook': 'cmd has no directory hook',

    'drawer.title': 'Appearance & terminal',
    'drawer.presets': 'Presets',
    'drawer.windowBg': 'Window background',
    'drawer.windowBgNote': 'UI only; each terminal can be colored separately.',
    'drawer.paneFollow': 'All terminals follow the window',
    'drawer.textColor': 'Text color',
    'drawer.fontSize': 'Font size',
    'drawer.fontSizeToast': 'Font size {n}px',
    'drawer.font': 'Font',
    'drawer.fontSarasa': 'Sarasa Mono (CJK monospace)',
    'drawer.fontYahei': 'Microsoft YaHei',
    'drawer.defaultShell': 'Default shell',
    'drawer.shellAuto': 'Auto (prefer PowerShell 7)',
    'drawer.shellCmd': 'Command Prompt (cmd)',
    'drawer.shellUpdated': 'Default shell updated; applies to new terminals',
    'drawer.startDir': 'Default start directory',
    'drawer.startDirNote': 'New terminals start here; override per terminal via “⋯ → Start directory”.',
    'drawer.startDirPlaceholder': 'Empty = home directory',
    'drawer.startDirHome': 'New terminals will start in your home directory',
    'drawer.startDirSet': 'New terminals start in: {path}',
    'drawer.startDirBad': "That directory doesn't exist",
    'drawer.clear': 'Clear',
    'drawer.browse': 'Browse…',
    'drawer.cursorBlink': 'Blinking cursor',
    'drawer.restore': 'Restore groups and layout on startup',
    'drawer.restoreTitle': 'Groups, each terminal\u2019s position and size, and the window size/state are remembered',
    'drawer.notify': 'Notify when a command finishes',
    'drawer.notifyTitle': 'Commands longer than 3s notify and flash the taskbar when the window is in the background',
    'drawer.reset': 'Restore defaults',
    'drawer.language': 'Language',
    'drawer.langAuto': 'System default',
    'drawer.langToast': 'Language switched to {name}',
    'drawer.paneBgLeft': 'Terminals still use custom backgrounds; click “All terminals follow the window”',

    'look.title': 'Terminal appearance',
    'look.bg': 'Background',
    'look.customBg': 'Custom background',
    'look.auto': 'Auto',
    'look.autoTitle': 'Pick a high-contrast text color from the background',
    'look.applyAllTitle': 'Copy this color scheme to every terminal and make it the default',
    'look.autoContrast': 'Auto contrast',
    'look.custom': 'Custom',
    'look.preview': 'Preview',
    'look.previewTag': '// preview',
    'look.applyAll': 'Apply to all terminals',
    'look.done': 'Done',
    'look.default': 'Default',
    'look.appliedAll': (v) => (v.n === 1 ? 'Applied to 1 terminal' : `Applied to all ${v.n} terminals`),
    'look.followWindow': 'All terminals follow the window background',
    'look.resetDone': 'Restored default appearance',

    'cwd.title': 'Start directory',
    'cwd.note': 'Where this terminal starts',
    'cwd.current': 'Current directory',
    'cwd.useThis': 'Use this',
    'cwd.recent': 'Recently used',
    'cwd.save': 'Save',
    'cwd.saveRestart': 'Save & restart',
    'cwd.reset': 'Follow default',
    'cwd.resetLabel': 'Use default',
    'cwd.home': 'Home',
    'cwd.defaultDir': 'Default directory',
    'cwd.noRecent': 'No records yet',
    'cwd.placeholder': 'Empty = follow the default {dir}',
    'cwd.placeholderHome': 'Empty = home directory',
    'cwd.livePending': "(the shell hasn't reported yet)",
    'cwd.ok': '✓ Directory exists: {path}',
    'cwd.notFolder': "That's not a folder; pick a directory",
    'cwd.notExist': "Directory doesn't exist (save will be blocked)",
    'cwd.pickNotFolder': "That's not a folder; choose again",
    'cwd.pickNotExist': 'Directory doesn\u2019t exist; pick a valid one',
    'cwd.restarted': 'Terminal restarted',
    'cwd.savedPending': 'Start directory saved; takes effect after restarting this terminal',
    'cwd.saved': 'Start directory saved',
    'cwd.resetDone': 'Using the default start directory',

    'boot.restored': (v) => `Restored last layout · ${v.groups} groups / ${v.panes} terminals`,
    'boot.xtermMissing': 'xterm.js failed to load: check that node_modules/@xterm is installed.',

    'main.pickDirTitle': 'Choose start directory',
    'main.pickDirButton': 'Use this folder',
    'main.spawnFailed': 'Failed to start {shell}: {reason}',
    'main.ptyLoadFailed': 'The pty module failed to load: run npm install first (node-pty or a prebuilt build)',

    'notify.doneTitle': 'Command finished',
    'notify.doneBody': (v) => `${v.title} · ${v.exit === 0 ? 'succeeded' : 'exit ' + v.exit} · ${v.time}`,
  };

  const dicts = { 'zh-CN': zhCN, 'en-US': enUS };
  const SUPPORTED = Object.keys(dicts);
  const FALLBACK = 'zh-CN';

  let locale = FALLBACK;
  const listeners = new Set();
  const missing = new Set();

  // auto → 跟随系统；不认识的系统语言退到英文
  function resolveLocale(setting, systemLocale) {
    if (setting && setting !== 'auto' && dicts[setting]) return setting;
    const sys = String(systemLocale || '');
    if (/^zh\b|^zh-/i.test(sys)) return 'zh-CN';
    if (/^en\b|^en-/i.test(sys)) return 'en-US';
    return 'en-US';
  }

  function lookup(loc, key) {
    const d = dicts[loc];
    return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
  }

  // t('group.paneCount', { n: 3 }) → 支持字符串占位与函数值
  function t(key, vars) {
    let v = lookup(locale, key);
    if (v === undefined) v = lookup(FALLBACK, key);
    if (v === undefined) {
      if (!missing.has(key)) {
        missing.add(key);
        if (typeof console !== 'undefined') console.warn('[i18n] missing key:', key);
      }
      return key;
    }
    if (typeof v === 'function') return String(v(vars || {}));
    if (!vars) return String(v);
    return String(v).replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])));
  }

  function has(key) {
    return lookup(locale, key) !== undefined || lookup(FALLBACK, key) !== undefined;
  }

  function setLocale(next) {
    const loc = dicts[next] ? next : FALLBACK;
    if (loc === locale) return locale;
    locale = loc;
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = loc;
    }
    for (const fn of [...listeners]) {
      try { fn(loc); } catch (e) { /* 单个订阅者出错不影响其它 */ }
    }
    return locale;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    t,
    has,
    setLocale,
    getLocale: () => locale,
    resolveLocale,
    onChange,
    supported: SUPPORTED,
    dicts,
    missingKeys: () => [...missing],
  };
});
