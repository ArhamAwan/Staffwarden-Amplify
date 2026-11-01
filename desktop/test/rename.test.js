'use strict';
// Workhelm became Staffwarden: on a Mac the update lands in the old Workhelm.app, which renames itself once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { macBundleRename, INTERNAL_NAME, NAME } = require('../src/rename');

const yes = () => true, no = () => false;
test('an updated Mac app still called Workhelm.app renames itself to Staffwarden.app', () => {
  assert.deepEqual(macBundleRename('/Applications/Workhelm.app/Contents/MacOS/Staffwarden', { exists: no, writable: yes }),
    { from: '/Applications/Workhelm.app', to: '/Applications/Staffwarden.app', execPath: '/Applications/Staffwarden.app/Contents/MacOS/Staffwarden' });
  assert.equal(macBundleRename('/Users/sara/Applications/Workhelm.app/Contents/MacOS/Staffwarden', { exists: no, writable: yes }).to, '/Users/sara/Applications/Staffwarden.app');
});
test('it leaves things alone when it may not, or need not, rename', () => {
  assert.equal(macBundleRename('/Applications/Staffwarden.app/Contents/MacOS/Staffwarden', { exists: no, writable: yes }), null, 'already renamed');
  assert.equal(macBundleRename('/Applications/Workhelm.app/Contents/MacOS/Staffwarden', { exists: yes, writable: yes }), null, 'a Staffwarden.app is already there');
  assert.equal(macBundleRename('/Applications/Workhelm.app/Contents/MacOS/Staffwarden', { exists: no, writable: no }), null, 'no permission');
  assert.equal(macBundleRename('/private/var/folders/x/AppTranslocation/ABC/d/Workhelm.app/Contents/MacOS/Staffwarden', { exists: no, writable: yes }), null, 'running from a download');
  assert.equal(macBundleRename('C:\\Users\\a\\AppData\\Local\\Programs\\Staffwarden\\Staffwarden.exe', { exists: no, writable: yes }), null, 'Windows');
});
test('inside, the app keeps its old name so sign-ins and timers carry over', () => {
  assert.equal(INTERNAL_NAME, 'Workhelm'); assert.equal(NAME, 'Staffwarden');
});
