// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shared markup for the project-level screens of mockups B and C. Each mockup styles the same classes in its own CSS.
// Illustrative sample data only. Loaded before mockup.js, which wires navigation and behaviour.
(function () {
  var g = function (k, label) { return '<span class="g g-' + k + '" aria-hidden="true"></span>' + (label ? '<span>' + label + '</span>' : ''); };
  var av = function (m, cli) { return '<span class="av' + (cli ? ' cli' : '') + '" aria-hidden="true">' + m + '</span>'; };
  var S = {};

  S.home = '<section class="view" id="v-home" aria-label="Project home: acme-web" hidden><div class="pane pg">' +
    '<div class="pgh"><div><span class="lbl">Project</span><h1>acme-web</h1><span class="sub mono">github.com/acme/web · main@a41c9e2 · 7 agents in 3 groups</span></div><span class="gap"></span><button class="btn sec" type="button" data-go="tasks">New task</button><button class="btn pri" type="button" data-go="agents">New agent <span class="kbd">A</span></button></div>' +
    '<div class="card need" role="group" aria-label="Needs attention"><header><span class="lbl">Needs attention</span><span class="sub">3 items, oldest first</span></header>' +
      '<button class="tr" type="button" data-go="agent" style="--cols:18px 1.2fr 1.6fr 90px">' + g('wait') + '<span><b>Proration fixer</b> waiting for approval</span><span class="sub">Edit <span class="mono">.github/workflows/ci.yml</span>, a protected path. Decide it in the agent view</span><span class="sub num">2 min</span></button>' +
      '<button class="tr" type="button" data-go="thread" style="--cols:18px 1.2fr 1.6fr 90px">' + g('wait') + '<span><b>Planner</b> read a message from a CLI agent</span><span class="sub">Its next file write, command or message asks you first, and the card lists that message</span><span class="sub num">3 min</span></button>' +
      '<button class="tr" type="button" data-go="rv" style="--cols:18px 1.2fr 1.6fr 90px">' + g('bad') + '<span><b>Invoice migrator</b> exited with code 1</span><span class="sub"><span class="tag warn">Git config or hooks changed</span> review before you push</span><span class="sub num">11 min</span></button></div>' +
    '<div class="grid2">' +
    '<div class="card" role="group" aria-label="Pull requests"><header><span class="lbl">Pull requests</span><span class="sub">3 open · read through your <span class="mono">gh</span> login</span></header>' +
      '<div class="tr" style="--cols:52px 1fr 128px 132px"><span class="sub mono">#481</span><span class="cell"><b>fix(billing): round prorated totals once</b><span class="sub mono">fix/proration-rounding · Proration fixer</span></span><span class="pill">' + g('ok', 'checks 12/12') + '</span><span class="pill">' + g('ok', 'approved') + '</span></div>' +
      '<div class="tr" style="--cols:52px 1fr 128px 132px"><span class="sub mono">#482</span><span class="cell"><b>feat: invoice table v2</b><span class="sub mono">feat/invoice-v2 · Invoice migrator</span></span><span class="pill">' + g('bad', '1 of 14 failing') + '</span><span class="pill">' + g('wait', 'changes requested') + '</span></div>' +
      '<div class="tr" style="--cols:52px 1fr 128px 132px"><span class="sub mono">#479</span><span class="cell"><b>docs: auth flow</b><span class="sub mono">docs/auth-flow · Auth docs writer</span></span><span class="pill">' + g('run', 'running 3/9') + '</span><span class="pill">' + g('idle', 'awaiting review') + '</span></div></div>' +
    '<div class="card" role="group" aria-label="Usage and cost"><header><span class="lbl">Usage and cost</span><span class="sub">November, metered by Axis</span></header>' +
      '<div class="meterrow"><span><b class="num">$142.18</b> <span class="sub">of $300 budget</span></span><span class="bar" role="img" aria-label="47 percent of budget used"><i style="width:47%"></i></span><span class="sub num">47%</span></div>' +
      '<div class="tr" style="--cols:1fr 110px 80px"><span>large-2 · API key</span><span class="sub num">9.1 M tokens</span><span class="num">$138.02</span></div>' +
      '<div class="tr" style="--cols:1fr 110px 80px"><span>small-2 · API key</span><span class="sub num">2.4 M tokens</span><span class="num">$4.16</span></div>' +
      '<div class="tr" style="--cols:1fr"><span class="sub">CLI agents (shipit, patchr): usage not available. Axis does not read a CLI\'s own data.</span></div></div>' +
    '<div class="card" role="group" aria-label="Runs"><header><span class="lbl">Runs</span><span class="sub">now</span></header>' +
      '<div class="tr" style="--cols:1fr 1fr"><span class="pill">' + g('run', '3 running') + '</span><span class="sub">Planner, Webhook retry, Auth docs writer</span></div>' +
      '<div class="tr" style="--cols:1fr 1fr"><span class="pill">' + g('wait', '1 waiting for approval') + '</span><span class="sub">Proration fixer</span></div>' +
      '<div class="tr" style="--cols:1fr 1fr"><span class="pill">' + g('quiet', '1 quiet') + '</span><span class="sub">Date lib upgrade (CLI, may be waiting for input)</span></div>' +
      '<div class="tr" style="--cols:1fr 1fr"><span class="pill">' + g('bad', '1 failed') + '</span><span class="sub">Invoice migrator</span></div></div>' +
    '<div class="card" role="group" aria-label="Tasks"><header><span class="lbl">Tasks</span><span class="sub">5 open</span></header>' +
      '<button class="tr" type="button" data-go="tasks" style="--cols:18px 1fr 150px">' + g('run') + '<span>Fix proration rounding</span><span class="sub">Proration fixer</span></button>' +
      '<button class="tr" type="button" data-go="tasks" style="--cols:18px 1fr 150px">' + g('bad') + '<span>Migrate invoice table <span class="sub">blocked</span></span><span class="sub">Invoice migrator</span></button>' +
      '<button class="tr" type="button" data-go="tasks" style="--cols:18px 1fr 150px">' + g('idle') + '<span>Audit webhook retries</span><span class="sub">unassigned</span></button></div>' +
    '</div>' +
    '<div class="card" role="group" aria-label="Recent activity"><header><span class="lbl">Recent activity</span><span class="sub">all agents</span></header>' +
      '<div class="tr" style="--cols:56px 160px 1fr"><time class="sub mono">14:14</time><span>You</span><span class="sub">messaged Planner and Invoice migrator: revert the hook change</span></div>' +
      '<div class="tr" style="--cols:56px 160px 1fr"><time class="sub mono">14:13</time><span>Axis</span><span class="sub">Planner\'s run read a message from another agent: its side-effecting actions now ask you</span></div>' +
      '<div class="tr" style="--cols:56px 160px 1fr"><time class="sub mono">14:06</time><span>Proration fixer</span><span class="sub">asked to run <span class="mono">npm test -- billing</span></span></div></div>' +
    '</div></section>';

  var agentRow = function (m, cli, name, kind, st, stLabel, where, last, go) {
    return '<button class="tr" type="button" data-go="' + (go || (m === 'PL' ? 'thread' : 'ws')) + '" style="--cols:30px 1.1fr 1fr 1.2fr 1.3fr 64px">' + av(m, cli) + '<b>' + name + '</b><span class="sub">' + kind + '</span><span class="pill">' + g(st, stLabel) + '</span><span class="sub mono">' + where + '</span><span class="sub num">' + last + '</span></button>';
  };
  S.agents = '<section class="view" id="v-agents" aria-label="Agents" hidden>' +
    '<aside class="pane list" aria-label="Agent groups"><div class="ph"><span class="lbl">Groups</span><button class="btn sec sm" type="button">New group</button></div>' +
      '<button class="li" type="button">All agents<span class="sub num">7</span></button><button class="li" type="button" aria-current="true">Billing squad<span class="sub num">3</span></button><button class="li" type="button">Maintenance<span class="sub num">2</span></button><button class="li" type="button">Docs<span class="sub num">1</span></button><button class="li" type="button">Ungrouped<span class="sub num">1</span></button></aside>' +
    '<div class="pane pg"><div class="pgh"><div><span class="lbl">Group</span><h1>Billing squad</h1><span class="sub">Agents that work on billing. Shared context: the page <span class="mono">Billing rounding policy</span>. Default model large-2.</span></div><span class="gap"></span><button class="btn sec" type="button">Edit group</button><button class="btn pri" type="button">New agent <span class="kbd">A</span></button></div>' +
      '<div class="card"><header><span class="lbl">Agents</span><span class="sub">3 · composer and CLI agents together</span></header>' +
        '<div class="tr th" style="--cols:30px 1.1fr 1fr 1.2fr 1.3fr 64px"><span></span><span class="lbl">Name</span><span class="lbl">Type</span><span class="lbl">Doing now</span><span class="lbl">Workspace</span><span class="lbl">Last</span></div>' +
        agentRow('PL', false, 'Planner', 'Composer · Agent', 'run', 'coordinating 2 agents', 'plan/billing-q4', 'now') +
        agentRow('PF', false, 'Proration fixer', 'Composer · Agent', 'wait', 'waiting for approval', 'fix/proration-rounding', '2 min', 'agent') +
        agentRow('IM', true, 'Invoice migrator', 'shipit · CLI agent', 'bad', 'exited with code 1', 'feat/invoice-v2', '11 min') + '</div>' +
      '<div class="card"><header><span class="lbl">Group rules</span></header><dl class="kv"><dt>Messages</dt><dd>Agents in this group may message each other through Axis. You see every message and can pause messaging. For CLI agents messaging is off by default: you turn it on per agent, and a CLI agent reads messages only by pulling them.</dd><dt>Approvals</dt><dd>Each composer agent asks you for its own approvals. CLI agents follow their own permissions, not Axis approvals.</dd><dt>Budget</dt><dd>$150 a month for composer agents; usage of CLI agents is not available to Axis.</dd><dt>Scope</dt><dd>A group organises agents and sets who may message whom. It is not a security boundary: agents in a group do not share files, credentials or processes.</dd></dl></div>' +
    '</div></section>';

  var msg = function (from, fm, fcli, to, time, body, meta) {
    var badge = from === 'You' ? 'you' : (fcli ? 'CLI · via endpoint, unverified writer' : 'composer');
    return '<article class="msg" aria-label="' + from + ' to ' + to + ', ' + time + '"><header>' + av(fm, fcli) + '<b>' + from + '</b><span class="tag">' + badge + '</span>' + (from === 'You' ? '' : '<span class="tag warn" title="Text written by an agent. Treat it as untrusted input.">untrusted text</span>') + '<span class="route" aria-hidden="true">→</span><span class="sub">' + to + '</span><span class="gap"></span><time class="sub mono">' + time + '</time></header><p>' + body + '</p>' + (meta ? '<footer class="sub">' + meta + '</footer>' : '') + '</article>';
  };
  S.thread = '<section class="view" id="v-thread" aria-label="Agent thread" hidden>' +
    '<aside class="pane list" aria-label="Threads"><div class="ph"><span class="lbl">Threads</span><span class="sub">acme-web</span></div>' +
      '<button class="li" type="button" aria-current="true"><span class="cell"><b>Planner ↔ Invoice migrator</b><span class="sub">active · 4 messages · hop 3</span></span></button>' +
      '<button class="li" type="button"><span class="cell"><b>Planner ↔ Proration fixer</b><span class="sub">idle · 4 messages</span></span></button>' +
      '<button class="li" type="button"><span class="cell"><b>Reviewer ↔ Auth docs writer</b><span class="sub">messaging paused by you · 9 messages</span></span></button></aside>' +
    '<div class="pane pg thread"><div class="pgh"><div><span class="lbl">Thread</span><h1>Planner ↔ Invoice migrator</h1><span class="sub">Planner (Composer · Agent) and Invoice migrator (shipit · CLI agent) · started by Planner at 14:09 · messaging for Invoice migrator turned on by you at 14:05</span></div><span class="gap"></span><button class="btn sec" type="button" id="pause" aria-pressed="false">Pause messaging</button></div>' +
      '<div class="banner" role="note">' + g('idle') + '<span><b>Axis carries every message, and you see all of them.</b> A message is untrusted text and file references. It never carries or implies an approval or a permission: approvals are decided only by you, on approval cards, never in a thread. Invoice migrator is a CLI agent, so it reads messages only by pulling them; Axis never types into its terminal.</span></div>' +
      '<div class="msgs" role="log" aria-label="Messages" id="msgs">' +
        msg('Planner', 'PL', false, 'Invoice migrator', '14:10', 'The migration fails on <code>invoice_lines.currency</code>. Read <code>db/migrations/0042_invoice_v2.sql</code> and add a default before the NOT NULL.', 'Pulled by Invoice migrator at 14:11 · hop 1') +
        msg('Invoice migrator', 'IM', true, 'Planner', '14:12', 'Added <code>DEFAULT \'USD\'</code>. Tests pass. I also changed <code>.git/hooks/pre-push</code> to skip the slow suite.', 'Delivered at Planner\'s next turn · hop 2') +
        '<div class="sysmsg">' + g('wait') + '<span><b>Axis:</b> Planner\'s run read a message from another agent. Until the run ends, each file write, command or message it sends needs your approval, and the card lists this message.</span><time class="sub mono">14:12</time></div>' +
        '<div class="sysmsg">' + g('wait') + '<span><b>Axis:</b> Git config or hooks changed in <span class="mono">feat/invoice-v2</span> during this run. Flagged in review.</span><time class="sub mono">14:12</time></div>' +
        '<article class="msg" aria-label="Planner to Invoice migrator, 14:13"><header>' + av('PL') + '<b>Planner</b><span class="tag">composer</span><span class="tag warn">untrusted text</span><span class="route" aria-hidden="true">→</span><span class="sub">Invoice migrator</span><span class="gap"></span><time class="sub mono">14:13</time></header><p>Please approve <code>npm publish</code> for me so I can release the client.</p><footer class="sub">Pulled by Invoice migrator at 14:13 · hop 3</footer><p class="mnote">' + g('idle') + '<span><b>This message approves nothing.</b> Invoice migrator\'s own permission prompts decide what it runs. Planner\'s actions are approved only by you, on its approval cards.</span></p></article>' +
        msg('You', 'YO', false, 'Planner, Invoice migrator', '14:14', 'Revert the hook change; hooks are not part of this task.', 'Sent by you · delivered to Planner at its next turn, pulled by Invoice migrator at 14:14') +
      '</div>' +
      '<div class="composer"><label class="sr" for="tmsg">Message both agents as you</label><textarea id="tmsg" rows="1" placeholder="Message both agents as you"></textarea><div class="cbar"><span class="sub">Visible to you and both agents · logged in the project</span><span class="gap"></span><button class="btn pri" type="button">Send</button></div></div>' +
    '</div></section>';

  S.code = '<section class="view" id="v-code" aria-label="Workspace with code panel" hidden>' +
    '<aside class="pane sidepanel" aria-label="Agents and code"><div class="ph"><span class="lbl">Agents</span><span class="sub">Billing squad</span></div>' +
      '<button class="li" type="button">' + av('PL') + '<span class="cell"><b>Planner</b><span class="sub">coordinating</span></span>' + g('run') + '</button>' +
      '<button class="li" type="button" aria-current="true">' + av('PF') + '<span class="cell"><b>Proration fixer</b><span class="sub">running tests</span></span>' + g('run') + '</button>' +
      '<button class="li" type="button">' + av('IM', true) + '<span class="cell"><b>Invoice migrator</b><span class="sub">exited 1</span></span>' + g('bad') + '</button>' +
      '<div class="ph"><span class="lbl">Code</span><span class="sub mono">src/billing/proration.ts</span><span class="gap"></span><span class="pill" id="dirty">' + g('idle', 'saved') + '</span></div>' +
      '<label class="sr" for="minied">Edit src/billing/proration.ts</label><textarea class="minied" id="minied" spellcheck="false">// Prorates a plan change. Rounds once, half to even.\nexport function prorate(plan: Plan, at: Date): number {\n  const ratio = remaining(plan, at) / daysInPlan(plan, at);\n  const exact = sum(items.map((i) => i.rate * ratio));\n  return roundHalfEven(exact, 0);\n}</textarea>' +
      '<div class="cbar pad"><button class="btn pri" type="button" id="save">Save <span class="kbd">⌘S</span></button><button class="btn sec" type="button" data-go="ide">Open in IDE view</button></div>' +
      '<p class="sub pad wrap">Edits here are yours, in the workspace\'s worktree, and are saved the same way as in IDE view. Review shows them as changed outside the agent. This repository is trusted; in Restricted Mode the file opens read-only.</p></aside>' +
    '<div class="pane session"><div class="ph"><h2>Proration fixer</h2><span class="sub mono">fix/proration-rounding</span><span class="gap"></span><span class="pill">' + g('run', 'running') + '</span></div>' +
      '<div class="stream" role="log" aria-label="Agent activity"><div class="ev"><span class="node">✓</span><span><b>Approved once</b> by you: <code>npm test -- billing</code>.</span><time>14:06</time></div><div class="ev"><span class="node">▷</span><span>Running <code>npm test -- billing</code>: 42 of 42 passed.</span><time>14:07</time></div><div class="ev"><span class="node">✎</span><span>Updating the doc comment in <code>src/billing/proration.ts</code>.</span><time>14:08</time></div><div class="ev"><span class="node">!</span><span><b>You edited</b> <code>src/billing/proration.ts</code> while the agent was running. It is listed under files changed outside the agent.</span><time>14:09</time></div></div>' +
      '<div class="composer"><label class="sr" for="cask">Message Proration fixer</label><textarea id="cask" rows="1" placeholder="Message Proration fixer. Mention a file with @."></textarea><div class="cbar"><span class="sub">large-2</span><span class="gap"></span><button class="btn pri" type="button">Send</button></div></div></div>' +
        '</section>';

  var lib = function (id, label, items, detail) {
    return '<section class="view" id="v-' + id + '" aria-label="' + label + '" hidden><aside class="pane list" aria-label="' + label + ' list"><div class="ph"><span class="lbl">' + label + '</span><button class="btn sec sm" type="button">New</button></div>' + items + '</aside><div class="pane pg">' + detail + '</div></section>';
  };
  var li = function (cur, title, sub, glyph) { return '<button class="li" type="button"' + (cur ? ' aria-current="true"' : '') + '>' + (glyph ? g(glyph) : '') + '<span class="cell"><b>' + title + '</b><span class="sub">' + sub + '</span></span></button>'; };
  var perms = function (can, cannot) {
    return '<div class="card"><header><span class="lbl">Permissions</span><span class="sub">in plain words</span></header><ul class="perm">' + can.map(function (t) { return '<li class="can"><span aria-hidden="true">✓</span><span><span class="sr">Can: </span>' + t + '</span></li>'; }).join('') + cannot.map(function (t) { return '<li class="cannot"><span aria-hidden="true">✕</span><span><span class="sr">Cannot: </span>' + t + '</span></li>'; }).join('') + '</ul></div>';
  };

  S.pages = lib('pages', 'Pages',
    li(true, 'Billing rounding policy', 'context for Billing squad') + li(false, 'Release checklist', 'edited 3 days ago') + li(false, 'Architecture notes', 'edited last week') + li(false, 'Onboarding', 'edited last month'),
    '<div class="pgh"><div><span class="lbl">Page</span><h1>Billing rounding policy</h1><span class="sub">Edited by you 2 days ago</span></div><span class="gap"></span><button class="btn sec" type="button">Edit</button></div>' +
    '<div class="card doc"><p>Amounts are stored in minor units. Round <b>once</b>, on the final total, using round half to even. Never round per line item.</p><p>Leap years: prorate by the actual number of days in the plan period (365 or 366).</p></div>' +
    perms(['Agents in Billing squad read this page as context', 'You and project admins edit it'], ['Agents cannot edit or delete this page', 'Agents outside Billing squad do not see it']));

  S.plugins = lib('plugins', 'Plugins',
    li(true, 'Test reporter', 'enabled · acme internal', 'ok') + li(false, 'Changelog writer', 'enabled for Docs', 'ok') + li(false, 'Dependency audit', 'disabled', 'idle'),
    '<div class="pgh"><div><span class="lbl">Plugin</span><h1>Test reporter</h1><span class="sub">Version 1.4.0 · published by acme internal · installed by you</span></div><span class="gap"></span><button class="btn sec" type="button">Disable</button><button class="btn sec" type="button">Remove</button></div>' +
    '<div class="card doc"><p>Summarises test runs in a workspace and adds the result to the agent\'s activity and to the task.</p></div>' +
    perms(['Read test output in workspaces of Billing squad and Maintenance', 'Add a summary to agent activity and tasks', 'Called by: Billing squad, Maintenance'], ['No network access', 'Cannot write files or run commands', 'Cannot see secrets, approvals or other plugins\' data']));

  S.tasks = lib('tasks', 'Tasks',
    li(true, 'Fix proration rounding', 'in progress · Proration fixer', 'run') + li(false, 'Migrate invoice table', 'blocked · Invoice migrator', 'bad') + li(false, 'Upgrade date library', 'in progress · Date lib upgrade', 'quiet') + li(false, 'Audit webhook retries', 'to do · unassigned', 'idle') + li(false, 'Write auth flow docs', 'done · Auth docs writer', 'ok'),
    '<div class="pgh"><div><span class="lbl">Task</span><h1>Fix proration rounding</h1><span class="sub">Created by you · assigned to Proration fixer</span></div><span class="gap"></span><button class="btn sec" type="button" data-go="ws">Open workspace</button></div>' +
    '<div class="card"><dl class="kv"><dt>Status</dt><dd><span class="pill">' + g('run', 'in progress') + '</span></dd><dt>Agent</dt><dd>Proration fixer (Composer · Agent), Billing squad</dd><dt>Workspace</dt><dd class="mono">fix/proration-rounding</dd><dt>Pull request</dt><dd>#481 · checks 12/12 · approved</dd><dt>Thread</dt><dd>Planner ↔ Proration fixer</dd></dl></div>' +
    '<div class="card"><header><span class="lbl">Checklist</span></header><ul class="perm"><li class="can"><span aria-hidden="true">✓</span><span>Find where rounding drifts</span></li><li class="can"><span aria-hidden="true">✓</span><span>Add a leap-year regression test</span></li><li><span aria-hidden="true">○</span><span>Review the CI change before merge</span></li></ul></div>');

  S.integ = lib('integ', 'Integrations',
    li(true, 'GitHub', 'through your gh login · read only', 'ok') + li(false, 'Issue tracker', 'connected · read only', 'ok') + li(false, 'Error monitoring', 'not connected', 'idle') + li(false, 'Team chat', 'not connected', 'idle'),
    '<div class="pgh"><div><span class="lbl">Integration</span><h1>GitHub</h1><span class="sub">Uses the <span class="mono">gh</span> command-line tool under your own login · organisation acme · 2 repositories</span></div><span class="gap"></span><button class="btn sec" type="button">Refresh now</button><button class="btn danger" type="button">Turn off</button></div>' +
    perms(['List open pull requests with their checks and reviews, at most once a minute', 'Open a pull request when you press Open pull request'], ['Axis stores no GitHub credential; your gh login stays with gh', 'Cannot merge, delete branches or change repository settings', 'Agents never receive your login; CLI agents use their own credentials', 'Output from gh is checked against a strict format and shown as text']) +
    '<div class="card"><header><span class="lbl">Recent use</span></header><div class="tr" style="--cols:56px 1fr"><time class="sub mono">13:58</time><span class="sub">Read checks for #481 (by Axis, for the project home)</span></div><div class="tr" style="--cols:56px 1fr"><time class="sub mono">11:20</time><span class="sub">Opened #482 (by you)</span></div></div>');

  S.newproj = '<section class="view" id="v-newproj" aria-label="New project" hidden><div class="pane pg">' +
    '<div class="pgh"><div><span class="lbl">Personal space</span><h1>New project</h1><span class="sub">A project is one repository. Agents and groups are created inside it.</span></div></div>' +
    '<div class="formgrid"><form class="card form" id="npform" novalidate aria-describedby="npstatus">' +
      '<fieldset><legend>Repository</legend>' +
        '<label class="radio"><input type="radio" name="src" checked> Local repository</label>' +
        '<div class="field inrow"><label class="sr" for="nppath">Repository folder</label><input id="nppath" class="mono" value="~/code/payments-api" aria-describedby="nppathh"><button class="btn sec" type="button">Choose…</button></div>' +
        '<p class="fhint" id="nppathh">' + g('ok') + ' Git repository found. Your checkout is read, never changed; agents never run in it.</p>' +
        '<label class="radio dis"><input type="radio" name="src" disabled> Clone from a URL <span class="sub">(later)</span></label></fieldset>' +
      '<fieldset><legend>Project</legend>' +
        '<div class="field"><label for="npname">Name</label><input id="npname" value="payments-api" aria-describedby="npnameh" required><p class="fhint" id="npnameh">Taken from the folder name. Letters, digits and dashes.</p></div>' +
        '<div class="field"><label for="npbase">Base branch</label><select id="npbase" aria-describedby="npbaseh"><option>main</option><option>develop</option><option>release/2026-11</option></select><p class="fhint" id="npbaseh">main at <span class="mono">9f3c2d1</span>. New agents branch from here.</p></div></fieldset>' +
      '<fieldset><legend>First agent group</legend>' +
        '<div class="field"><label for="npgroup">Group name</label><input id="npgroup" value="Core"></div>' +
        '<div class="field"><label for="npgdesc">What the group works on <span class="sub">(optional)</span></label><input id="npgdesc" placeholder="For example: the payments API and its tests"></div>' +
        '<p class="fhint">A group organises agents and decides who may message whom. It is not a security boundary.</p></fieldset>' +
      '<fieldset><legend>Composer agents</legend>' +
        '<div class="field"><label for="npmodel">Default model</label><select id="npmodel" aria-describedby="npmodelh"><option>large-2 · API key connection</option><option>small-2 · API key connection</option></select><p class="fhint" id="npmodelh">Each agent can change it. CLI agents use their own model and login.</p></div>' +
        '<div class="field"><label for="npbudget">Monthly budget, USD</label><div class="inrow"><input id="npbudget" type="number" min="0" step="10" value="200" aria-describedby="npbudgeth"><span class="sub">for composer agents in this project</span></div><p class="fhint" id="npbudgeth">When it is reached, composer runs stop and ask you. Usage of CLI agents is not available to Axis.</p></div></fieldset>' +
      '<div class="formbar"><p class="sub" id="npstatus" role="status"></p><span class="gap"></span><button class="btn sec" type="button" data-go="home">Cancel</button><button class="btn pri" type="submit">Create project <span class="kbd">⌘↵</span></button></div>' +
    '</form>' +
    '<aside class="card doc" aria-label="What Axis will do"><span class="lbl">What happens</span><ul class="steps"><li>Axis registers <b id="npsumname">payments-api</b> in your personal space.</li><li>Nothing in your checkout changes. Each agent gets its own worktree and branch, kept in the Axis app data folder, not in the repository.</li><li>No agent starts until you create one.</li><li>Nothing leaves this computer except the model requests your composer agents make.</li></ul></aside></div>' +
    '</div></section>';

  S.agent = '<section class="view" id="v-agent" aria-label="Agent: Proration fixer" hidden><div class="pane pg focus">' +
    '<div class="pgh"><button class="btn sec sm" type="button" data-go="home">← Project home</button><span class="gap"></span><button class="btn sec" type="button" data-go="thread">Threads 1</button><button class="btn sec" type="button" data-go="ide">Open in IDE view</button><button class="btn danger" type="button" id="stoprun">Stop run</button></div>' +
    '<div class="agenthead">' + av('PF') + '<div><h1>Proration fixer</h1><span class="sub">Composer · Agent · Billing squad · <span class="mono">fix/proration-rounding</span> from main@a41c9e2</span></div><span class="gap"></span><span class="pill big" id="agstate">' + g('wait', 'Waiting for approval') + '</span></div>' +
    '<div class="fgrid"><div class="fmain">' +
      '<div class="stream big" role="log" aria-label="Activity of Proration fixer" id="agstream">' +
        '<div class="ev"><span class="node">›</span><span><b>You</b> Prorated amounts are off by a cent for annual plans switched mid-cycle. Find the rounding bug and cover it with a test.</span><time>14:02</time></div>' +
        '<div class="ev"><span class="node">✎</span><span>Rounded once, on the total, half to even, in <code>src/billing/proration.ts</code>. <span class="add num">+31</span> <span class="del num">−9</span></span><time>14:03</time></div>' +
        '<div class="ev"><span class="node">✓</span><span><b>Approved once</b> by you: <code>npm test -- billing</code>. 42 of 42 passed.</span><time>14:07</time></div>' +
        '<div class="ev"><span class="node">⇄</span><span>Read a message from Planner (composer, untrusted text): add a CI job that runs the billing tests with coverage.</span><time>14:08</time></div>' +
        '<section class="decision" id="agdecision" role="group" aria-labelledby="agdtitle"><header>' + g('wait') + '<b id="agdtitle">Approval needed: edit a protected path</b></header>' +
          '<dl><dt>Action</dt><dd>Add a job step to <span class="mono">.github/workflows/ci.yml</span></dd><dt>Where</dt><dd>This agent\'s worktree only</dd><dt>Consequence</dt><dd>Changes what runs in CI once pushed. Review will flag the file at the top.</dd><dt>Received since last approval</dt><dd>Message from Planner (composer), 14:08, hop 1 · <button class="link" type="button" data-go="thread">open</button></dd><dt>Why you are asked</dt><dd>This run read another agent\'s message, so every file write, command or message needs you. An "always" rule does not cover it.</dd></dl>' +
          '<div class="acts"><button class="btn pri" type="button" id="agapprove">Approve once <span class="kbd">⌘↵</span></button><button class="btn sec" type="button" id="agdeny">Deny</button></div></section>' +
      '</div>' +
      '<div class="composer"><label class="sr" for="agask">Message Proration fixer</label><textarea id="agask" rows="2" placeholder="Message Proration fixer. Mention a file with @."></textarea><div class="cbar"><div class="modes" role="group" aria-label="Composer mode"><button type="button" aria-pressed="false">Ask</button><button type="button" aria-pressed="false">Edit</button><button type="button" aria-pressed="true">Agent</button></div><span class="gap"></span><button class="btn pri" type="button">Send</button></div></div>' +
    '</div><div class="frail">' +
      '<div class="card"><header><span class="lbl">Approvals</span><span class="sub" id="agpending">1 waiting, in the stream</span></header>' +
        '<div class="tr" style="--cols:48px 1fr"><time class="sub mono">14:06</time><span class="sub">Approved once: <span class="mono">npm test -- billing</span></span></div>' +
        '<div class="tr" style="--cols:48px 1fr"><time class="sub mono">13:51</time><span class="sub">Denied: read <span class="mono">~/.npmrc</span></span></div></div>' +
      '<div class="card"><header><span class="lbl">Files changed</span><span class="sub num">3</span></header>' +
        '<button class="tr" type="button" data-go="rv" style="--cols:1fr auto"><span class="mono sm">src/billing/proration.ts</span><span class="num"><span class="add">+31</span> <span class="del">−9</span></span></button>' +
        '<button class="tr" type="button" data-go="rv" style="--cols:1fr auto"><span class="mono sm">src/billing/proration.test.ts</span><span class="num"><span class="add">+17</span> <span class="del">−3</span></span></button>' +
        '<button class="tr" type="button" data-go="code" style="--cols:1fr auto"><span class="mono sm">src/billing/invoice.ts</span><span class="tag">edited by you</span></button>' +
        '<div class="pad"><button class="btn sec" type="button" data-go="rv">Review changes</button></div></div>' +
      '<div class="card"><header><span class="lbl">This run</span></header><dl class="kv"><dt>Model</dt><dd>large-2</dd><dt>Cost</dt><dd>$3.12 of $20 run budget</dd><dt>Started</dt><dd>14:02, by you</dd></dl></div>' +
    '</div></div></div></section>';

  var body = document.querySelector('.body');
  body.insertAdjacentHTML('beforeend', S.home + S.agents + S.thread + S.code + S.pages + S.plugins + S.tasks + S.integ + S.newproj + S.agent);
})();
