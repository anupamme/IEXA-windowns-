const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');
const { makeAgentTools } = require('../dist/main/tools/ToolDefinitions');
const { ProcessManager } = require('../dist/main/tools/shell/ProcessManager');

test('application tasks prefer direct commands and APIs, GUI remains a separate route', () => {
  const prompt = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: true });
  const routing = prompt.indexOf('先按用户意图选工具');
  const gui = prompt.indexOf('桌面 GUI 任务使用 desktop_control');
  assert.ok(routing >= 0 && gui > routing);
  assert.match(prompt, /优先使用 file_\* 或 shell_execute/);
  assert.match(prompt, /需要读屏或控件交互、或经检查没有可用命令\/API 时，才用 desktop_control/);
  assert.match(prompt, /不要用 shell\/curl 代替 desktop_control 或绕开它的焦点\/审批保护/);
  assert.doesNotMatch(prompt, /桌面任务直接使用 desktop_control/);
  const tools = makeAgentTools();
  const shell = tools.find(t => t.name === 'shell_execute');
  const desktop = tools.find(t => t.name === 'desktop_control');
  assert.match(shell.description, /Prefer direct CLI, PowerShell and public APIs/);
  assert.match(desktop.description, /Use this for actual GUI observation and input/);
});

test('choice questions to the user route through the ask_user card', () => {
  const prompt = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: true });
  const toolsList = prompt.indexOf('你可以使用以下工具');
  const ask = prompt.indexOf('- **ask_user**');
  assert.ok(toolsList >= 0 && ask > toolsList, 'ask_user is introduced in the tool list');
  assert.ok(prompt.includes('需要用户做选择、勾选、确认或给出关键决定时'), 'tool bullet explains when to use it');
  const comm = prompt.indexOf('## 任务沟通与澄清');
  const guidance = prompt.indexOf('需要用户回答选择题');
  assert.ok(comm >= 0 && guidance > comm, 'choice-question guidance lives in the communication section');
  assert.ok(prompt.includes('应使用 **ask_user** 工具弹出问答卡片向用户提问并等待作答'), 'guidance names the tool');
  assert.ok(prompt.includes('不要用纯文本代替卡片向用户提这类选择题'), 'guidance steers away from plain-text choice questions');
  const tools = makeAgentTools();
  const askTool = tools.find((t) => t.name === 'ask_user');
  assert.ok(askTool, 'ask_user is exposed to providers');
  assert.ok(String(askTool.description).includes('ask the user through an interactive card'), 'tool description promises the card');
});

test('the existing PowerShell process route executes a real command', { skip: process.platform !== 'win32' }, async () => {
  const result = await new ProcessManager().run(
    "Write-Output 'IEXA_SHELL_OK'", process.cwd(), new AbortController().signal,
    { timeoutMs: 15000, maxOutputBytes: 4096, killGracePeriodMs: 1500 }, 'powershell',
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /IEXA_SHELL_OK/);
});
