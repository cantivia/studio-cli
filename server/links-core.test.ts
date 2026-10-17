import assert from 'node:assert/strict';
import test from 'node:test';
import { Brake, expiryFor, guestText, incomingText, introText, isLasts, isLive, peekText } from './links-core.ts';

test('link lengths count from now, and "never" has no end', () => {
  assert.equal(expiryFor('1h', 1000), 1000 + 3_600_000);
  assert.equal(expiryFor('30d', 0), 30 * 86_400_000);
  assert.equal(expiryFor('never', 5), null);
  assert.ok(isLasts('7d') && !isLasts('2d') && !isLasts(undefined));
});

test('a link with no end date is always live; others until they expire', () => {
  assert.ok(isLive({ expiresAt: null }, 1e15));
  assert.ok(isLive({ expiresAt: 10 }, 9));
  assert.ok(!isLive({ expiresAt: 10 }, 10));
});

test('the brake pauses after 20 messages unless a person types', () => {
  const b = new Brake();
  for (let i = 0; i < 19; i++) assert.equal(b.message(), false);
  b.human();
  for (let i = 0; i < 19; i++) assert.equal(b.message(), false);
  assert.equal(b.message(), true);
});

test('messages say who they are from and how to reply', () => {
  assert.match(incomingText('Feargal  Browne', 'hi'), /^Message from Feargal Browne's Claude \(reply with: studio tell/);
  assert.match(guestText('', 'hi'), /^Message from a guest \(a guest on your share link\):\n\nhi$/);
  assert.match(introText('Ashkan', '~/proj'), /studio tell "your message".*studio peek/);
});

test('peek lists the conversation with tools indented', () => {
  const t = peekText('Ashkan', [
    { kind: 'user', text: 'fix the test' },
    { kind: 'tool', tool: 'Bash', text: 'npm test' },
    { kind: 'assistant', text: 'Fixed.' },
  ]);
  assert.match(t, /Ashkan: fix the test\n  \(Bash\) npm test\nClaude: Fixed\.$/);
  assert.match(peekText('A', []), /hasn't done anything yet/);
});
