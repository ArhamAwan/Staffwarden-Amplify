'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boostIdOf, placeBoost, shouldPopUp, BoostQueue } = require('../src/boost');

test('only boost-clip notifications open the clip, and they say which boost', () => {
  assert.equal(boostIdOf({ kind: 'boost_clip', link: '#/?boost=42' }), 42);
  assert.equal(boostIdOf({ kind: 'boost', link: '#/?boost=42' }), null, 'a plain boost stays a notification');
  assert.equal(boostIdOf({ kind: 'boost_clip', link: '#/' }), null);
  assert.equal(boostIdOf(null), null);
});

test('the window sits on the bottom edge, in the chosen corner, above the Dock or taskbar', () => {
  const area = { x: 0, y: 25, width: 1440, height: 850 };   // a Mac: menu bar on top, Dock below
  assert.deepEqual(placeBoost(area, 'right'), { x: 720, y: 395, width: 720, height: 480 });
  assert.deepEqual(placeBoost(area, 'left'), { x: 0, y: 395, width: 720, height: 480 });
  // a second screen to the left, and a small one
  assert.deepEqual(placeBoost({ x: -1280, y: 0, width: 1280, height: 760 }, 'right'), { x: -720, y: 280, width: 720, height: 480 });
  assert.deepEqual(placeBoost({ x: 0, y: 0, width: 600, height: 400 }, 'right'), { x: 0, y: 0, width: 600, height: 400 });
});

test('it pops up only while the timer is on, and only when the server says so', () => {
  assert.equal(shouldPopUp('running', { popup: true }), true);
  assert.equal(shouldPopUp('paused', { popup: true }), true, 'on a break still counts as at work');
  assert.equal(shouldPopUp('stopped', { popup: true }), false);
  assert.equal(shouldPopUp('running', { popup: false }), false, 'notification-only, or a fourth one this shift');
  assert.equal(shouldPopUp('running', null), false);
});

test('one at a time: the next waits for the first to leave, and none shows twice', () => {
  const opened = [];
  const q = new BoostQueue((b) => opened.push(b.id));
  assert.equal(q.push({ id: 1 }), true);
  assert.equal(q.push({ id: 2 }), true);
  assert.equal(q.push({ id: 1 }), false, 'already shown');
  assert.deepEqual(opened, [1]);
  assert.equal(q.done().id, 2);
  assert.deepEqual(opened, [1, 2]);
  assert.equal(q.done(), null);
  q.push({ id: 3 });
  assert.deepEqual(opened, [1, 2, 3]);
});
