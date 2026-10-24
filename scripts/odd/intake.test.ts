import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeEmoji, intakePrompt, pendingIntake, slackSourceLabel } from './intake.ts';

test('only fresh top-level human messages reach Intake, oldest first', () => {
  const pending = pendingIntake([
    { ts: '1791902233.814579', text: 'kiosk shows stale price after reconnect', userName: 'devon' },
    { ts: '1791902230.000001', text: 'ups beeps on boot', userName: 'devon', reactions: [{ name: intakeEmoji, count: 1 }] },
    { ts: '1791902231.000001', text: 'reply in thread', threadTs: '1791902230.000001' },
    { ts: '1791902232.000001', text: 'posted by Amp', originThreadID: 'T-1' },
    { ts: '1791902229.000001', text: '@U0 has joined the channel' },
    { ts: '1791902228.000001', text: 'meter drops samples at 2am', threadTs: '1791902228.000001', replyCount: 1 } as never,
    { ts: '1791902227.000001', text: '   ' },
  ]);
  assert.deepEqual(pending.map(message => message.ts), ['1791902228.000001', '1791902233.814579']);
});

test('source label obeys Amp label syntax and the prompt names the source', () => {
  const label = slackSourceLabel('1791902233.814579');
  assert.equal(label, 'odd-slack-1791902233-814579');
  assert.match(label, /^[a-z0-9][a-z0-9-]{0,31}$/);
  const prompt = intakePrompt({ ts: '1791902233.814579', text: '(Reply from @devon on Slack) kiosk shows stale price', userName: 'devon' }, '[odd]');
  assert.match(prompt, /^\[odd\] Intake from Slack #factory-intake \(message ts 1791902233\.814579, from devon\)/);
  assert.match(prompt, /\nkiosk shows stale price$/);
});
