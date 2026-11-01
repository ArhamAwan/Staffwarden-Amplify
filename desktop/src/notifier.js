'use strict';
// Desktop pop-ups for the person's Workhelm notifications (tasks, reviews, comments, deadlines, time
// off, team alerts). Polls the server for anything newer than the last one shown, so nothing pops up
// twice, not even after a restart; what arrived while the app was closed is not replayed as a burst.
const { NetworkError } = require('./client');

class Notifier {
  // store: { get(userId) -> lastId | null, set(userId, lastId) }; show(n) puts one pop-up on screen.
  constructor({ client, store, show, maxBurst = 3, prefsEveryMs = 5 * 60000, now = Date.now }) {
    Object.assign(this, { client, store, show, maxBurst, prefsEveryMs, now });
    this.userId = null; this.desktop = true; this.prefsAt = 0; this.busy = false;
  }

  setUser(id) { if (id !== this.userId) { this.userId = id; this.prefsAt = 0; } }

  async poll() {
    if (!this.userId || this.busy) return [];
    this.busy = true;
    try {
      if (this.now() - this.prefsAt > this.prefsEveryMs) {
        try { const p = await this.client.notifyPrefs(); this.desktop = p.desktop !== false; this.prefsAt = this.now(); } catch (e) { if (!(e instanceof NetworkError)) this.prefsAt = this.now(); }
      }
      const last = this.store.get(this.userId);
      if (last == null) {                                   // first run for this person: start from now
        const r = await this.client.notifications({ limit: 1 });
        this.store.set(this.userId, r.last_id || 0);
        return [];
      }
      const r = await this.client.notifications({ after: last, limit: 50 });
      if (!r.items.length) return [];
      const fresh = r.items.filter((n) => !n.read);
      this.store.set(this.userId, Math.max(last, ...r.items.map((n) => n.id)));
      if (!this.desktop || !fresh.length) return [];
      // a boost clip always gets its own pop-up: it is never folded into "5 new notifications"
      const clips = fresh.filter((n) => n.kind === 'boost_clip'), rest = fresh.filter((n) => n.kind !== 'boost_clip');
      const out = [...clips, ...(rest.length > this.maxBurst
        ? [{ id: null, ids: rest.map((n) => n.id), title: `${rest.length} new notifications`, body: rest.slice(-3).map((n) => n.title).join('\n'), link: '#/' }]
        : rest)];
      for (const n of out) this.show(n);
      return out;
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      return [];
    } finally { this.busy = false; }
  }
}

module.exports = { Notifier };
