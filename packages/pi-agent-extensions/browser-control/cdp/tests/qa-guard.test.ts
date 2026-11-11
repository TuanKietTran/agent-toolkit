import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSubmitLike } from '../guard.ts';

test('guard: type=submit is submit-like whatever the name', () => {
  assert.equal(isSubmitLike({ role: 'button', name: 'Save', inputType: 'submit' }), true);
  assert.equal(isSubmitLike({ role: 'button', name: '', inputType: 'submit', inForm: true }), true);
});

test('guard: contract action names are submit-like, case-insensitive', () => {
  const names = ['Submit', 'Pay', 'Buy now', 'Purchase', 'Place order', 'Confirm', 'Send', 'Post', 'Publish', 'Delete', 'Checkout', 'Subscribe', 'Sign up', 'Register', 'Apply'];
  for (const name of names) {
    assert.equal(isSubmitLike({ role: 'button', name }), true, name);
    assert.equal(isSubmitLike({ role: 'button', name: name.toUpperCase() }), true, name.toUpperCase());
  }
});

test('guard: submit-like names match inside longer labels', () => {
  assert.equal(isSubmitLike({ role: 'button', name: 'Place order now' }), true);
  assert.equal(isSubmitLike({ role: 'button', name: 'Delete item' }), true);
  assert.equal(isSubmitLike({ role: 'link', name: 'Checkout' }), true);
  assert.equal(isSubmitLike({ role: 'button', name: 'Sign Up for free' }), true);
});

test('guard: harmless buttons are not submit-like', () => {
  for (const name of ['Ping', 'Save', 'Save entry', 'Hello', 'Cancel', 'Close', 'Back', 'Read more', 'Continue', 'Retry']) {
    assert.equal(isSubmitLike({ role: 'button', name, inputType: 'button' }), false, name);
  }
});

test('guard: plain inputs and textboxes are not submit-like', () => {
  assert.equal(isSubmitLike({ role: 'textbox', name: 'Email', inputType: 'email' }), false);
  assert.equal(isSubmitLike({ role: 'checkbox', name: 'I agree to the terms' }), false);
  assert.equal(isSubmitLike({ role: 'combobox', name: 'Colour' }), false);
});
