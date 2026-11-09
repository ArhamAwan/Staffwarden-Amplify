'use strict';
// What each plan costs and what it includes. Prices are per active person, in US dollars; paying for a year
// gets two months free (10 months' price), paying monthly costs 20% more than the yearly price per month.
// During the free trial every feature is on.

const PLANS = {
  starter: { name: 'Starter', year: 48, month: 4.8, blurb: 'Hours, attendance and time off for a small team.' },
  business: { name: 'Business', year: 84, month: 8.4, blurb: 'Everything to run people: pay, HR and projects.' },
  pro: { name: 'Pro', year: 120, month: 12, blurb: 'For teams that work for clients.' },
};
const ORDER = ['starter', 'business', 'pro'];
const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;        // a declined card: tracking keeps going this long
const KEEP_DAYS = 60;        // a paused or closed company's data is kept this long, then deleted

// features beyond Starter, and the plan that first has them
const FEATURES = {
  payroll: 'business', hr: 'business', projects: 'business', reports: 'business',
  portal: 'pro', screenshots: 'pro', shift_reports: 'pro',
};
// which part of the API each feature is
const API_FEATURE = [
  [/^\/api\/(payroll|advances)(\/|$)/, 'payroll'],
  [/^\/api\/(hr|expenses|assets)(\/|$)/, 'hr'],
  [/^\/api\/(projects|tasks)(\/|$)/, 'projects'],
  [/^\/api\/reports(\/|$)/, 'reports'],
  [/^\/api\/(portal|clients|client-health|client-inbox|client-people)(\/|$)/, 'portal'],
  [/^\/api\/screenshots(\/|$)/, 'screenshots'],
  [/^\/api\/shift-reports(\/|$)/, 'shift_reports'],
];
const featureOf = (pathname) => { for (const [re, f] of API_FEATURE) if (re.test(pathname)) return f; return null; };
const planHas = (plan, feature) => !FEATURES[feature] || ORDER.indexOf(plan) >= ORDER.indexOf(FEATURES[feature]);
const featuresOf = (plan) => Object.keys(FEATURES).filter((f) => planHas(plan, f));

// the price of one person for a whole period, in cents
const seatCents = (plan, interval) => Math.round((PLANS[plan] ? PLANS[plan][interval === 'month' ? 'month' : 'year'] : 0) * 100);
const validPlan = (p) => Object.prototype.hasOwnProperty.call(PLANS, p);
const validInterval = (i) => i === 'month' || i === 'year';

module.exports = { PLANS, ORDER, TRIAL_DAYS, GRACE_DAYS, KEEP_DAYS, FEATURES, featureOf, planHas, featuresOf, seatCents, validPlan, validInterval };
