'use strict';

class NetworkError extends Error {}
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class Client {
  constructor({ baseUrl, getToken = () => null, fetchImpl = globalThis.fetch, headers = {} }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.extraHeaders = headers;   // e.g. which app version this is, so the owner can see who needs to update
    this.getToken = getToken;
    this.fetch = fetchImpl;
  }

  async req(method, path, body) {
    const token = this.getToken();
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...this.extraHeaders, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      // say plainly that the server could not be reached, with the technical reason in brackets
      const why = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'network error';
      throw new NetworkError(`Can't reach the Staffwarden server. Check your internet connection and try again. (${why})`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
  }

  login(email, password) { return this.req('POST', '/api/auth/login', { email, password }); }
  me() { return this.req('GET', '/api/me'); }
  settings() { return this.req('GET', '/api/settings'); }
  acceptPolicy() { return this.req('POST', '/api/me/consent'); }
  projects() { return this.req('GET', '/api/projects'); }
  myTasks() { return this.req('GET', '/api/tasks?assignee=me&status=todo,in_progress,in_review'); }
  taskSummary() { return this.req('GET', '/api/tasks/summary'); }
  setTaskStatus(id, status) { return this.req('PATCH', `/api/tasks/${id}`, { status }); }
  notifications({ after, limit = 30 } = {}) { return this.req('GET', `/api/notifications?limit=${limit}${after != null ? `&after=${after}` : ''}`); }
  readNotifications(ids) { return this.req('POST', '/api/notifications/read', ids === 'all' ? { all: true } : { ids }); }
  notifyPrefs() { return this.req('GET', '/api/me/notify-prefs'); }
  startTimer(projectId, taskId) {
    return this.req('POST', '/api/timer/start', { ...(projectId ? { project_id: projectId } : {}), ...(taskId ? { task_id: taskId } : {}) });
  }
  pauseTimer(reason, at) { return this.req('POST', '/api/timer/pause', { reason, ...(at ? { at } : {}) }); }
  resumeTimer(at) { return this.req('POST', '/api/timer/resume', at ? { at } : {}); }
  idle(state, at) { return this.req('POST', '/api/timer/idle', { state, ...(at ? { at } : {}) }); }
  stopTimer(endedAt, reason) { return this.req('POST', '/api/timer/stop', { ...(endedAt ? { ended_at: endedAt } : {}), ...(reason ? { reason } : {}) }); }
  currentTimer() { return this.req('GET', '/api/timer/current'); }
  ping() { return this.req('POST', '/api/timer/ping'); }
  daySummary(day) { return this.req('GET', '/api/users/me/day' + (day ? `?day=${day}` : '')); }
  postActivity(p) { return this.req('POST', '/api/activity', p); }
  postScreenshot({ slot_start, taken_at, buf, thumb, privacy }) {
    return this.req('POST', '/api/screenshots', { slot_start, taken_at, image_base64: buf.toString('base64'), ...(thumb ? { thumb_base64: thumb.toString('base64') } : {}), ...(privacy ? { privacy } : {}) });
  }
}

module.exports = { Client, NetworkError, ApiError };
