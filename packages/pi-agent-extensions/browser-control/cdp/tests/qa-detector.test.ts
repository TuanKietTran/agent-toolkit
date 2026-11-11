import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectBlock } from '../detector.ts';
import type { PageFacts } from '../contract.ts';

const clean: PageFacts = { url: 'http://127.0.0.1:1234/page.html', title: 'Fixture Form', text: 'Fixture Form Full name Email Colour I agree to the terms Ping Place order Delete item Scroll bottom marker' };

test('detector: ordinary page is not blocked', () => {
  const d = detectBlock(clean);
  assert.equal(d.blocked, false);
  assert.equal(d.reason, undefined);
});

test('detector: captcha wording is a captcha STOP', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/captcha.html', title: 'Captcha challenge', text: 'Please complete the captcha below to continue. I am not a robot' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'captcha');
});

test('detector: verify-you-are-human is a captcha STOP, case-insensitive', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/x', title: 'Check', text: 'VERIFY YOU ARE HUMAN to continue' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'captcha');
});

test('detector: cloudflare challenge is a bot_check STOP', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/cloudflare.html', title: 'Just a moment', text: 'Cloudflare challenge: checking your browser before accessing this site.' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'bot_check');
});

test('detector: sign-in page with a password field is a login_wall STOP', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/login.html', title: 'Sign in', text: 'Sign in Log in to continue Username Password Sign in' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'login_wall');
});

test('detector: login-like urls are a login_wall STOP even with neutral text', () => {
  for (const url of ['https://example.test/login', 'https://example.test/signin', 'https://accounts.example.test/']) {
    const d = detectBlock({ url, title: 'Welcome', text: 'Welcome back, please continue' });
    assert.equal(d.blocked, true, url);
    assert.equal(d.reason, 'login_wall', url);
  }
});

test('detector: 429 status text is a rate_limit STOP', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/ratelimit.html', title: 'Too many requests', text: 'Error 429: rate limit exceeded. Please slow down.' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'rate_limit');
});

test('detector: too-many-requests wording is a rate_limit STOP', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/x', title: 'Slow down', text: 'You have sent too many requests in a given amount of time.' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'rate_limit');
});

test('detector: unusual traffic wording is an unusual_traffic STOP', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/traffic.html', title: 'Unusual traffic', text: 'Our systems have detected unusual traffic from your computer network.' });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'unusual_traffic');
});

test('detector: blocked results carry string evidence when present', () => {
  const d = detectBlock({ url: 'http://127.0.0.1/captcha.html', title: 'Captcha', text: 'complete the captcha' });
  assert.equal(d.blocked, true);
  if (d.evidence !== undefined) assert.equal(typeof d.evidence, 'string');
});
