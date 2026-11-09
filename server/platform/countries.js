'use strict';
// Countries a company can pick at sign-up: the time zone, money and public holidays it starts with.
// Everything can be changed later in Settings. `holidays` names a list in lib/holidays.js.
const COUNTRIES = [
  { code: 'PK', name: 'Pakistan', tz: 'Asia/Karachi', currency: 'PKR', money: 'Pakistani rupees', holidays: 'PK' },
  { code: 'US', name: 'United States', tz: 'America/New_York', currency: 'USD', money: 'US dollars', holidays: 'US' },
  { code: 'GB', name: 'United Kingdom', tz: 'Europe/London', currency: 'GBP', money: 'British pounds' },
  { code: 'AE', name: 'United Arab Emirates', tz: 'Asia/Dubai', currency: 'AED', money: 'UAE dirhams' },
  { code: 'SA', name: 'Saudi Arabia', tz: 'Asia/Riyadh', currency: 'SAR', money: 'Saudi riyals' },
  { code: 'QA', name: 'Qatar', tz: 'Asia/Qatar', currency: 'QAR', money: 'Qatari riyals' },
  { code: 'IN', name: 'India', tz: 'Asia/Kolkata', currency: 'INR', money: 'Indian rupees' },
  { code: 'BD', name: 'Bangladesh', tz: 'Asia/Dhaka', currency: 'BDT', money: 'Bangladeshi taka' },
  { code: 'PH', name: 'Philippines', tz: 'Asia/Manila', currency: 'PHP', money: 'Philippine pesos' },
  { code: 'CA', name: 'Canada', tz: 'America/Toronto', currency: 'CAD', money: 'Canadian dollars' },
  { code: 'AU', name: 'Australia', tz: 'Australia/Sydney', currency: 'AUD', money: 'Australian dollars' },
  { code: 'DE', name: 'Germany', tz: 'Europe/Berlin', currency: 'EUR', money: 'euros' },
  { code: 'NL', name: 'Netherlands', tz: 'Europe/Amsterdam', currency: 'EUR', money: 'euros' },
  { code: 'IE', name: 'Ireland', tz: 'Europe/Dublin', currency: 'EUR', money: 'euros' },
  { code: 'TR', name: 'Türkiye', tz: 'Europe/Istanbul', currency: 'TRY', money: 'Turkish lira' },
  { code: 'EG', name: 'Egypt', tz: 'Africa/Cairo', currency: 'EGP', money: 'Egyptian pounds' },
  { code: 'NG', name: 'Nigeria', tz: 'Africa/Lagos', currency: 'NGN', money: 'Nigerian naira' },
  { code: 'KE', name: 'Kenya', tz: 'Africa/Nairobi', currency: 'KES', money: 'Kenyan shillings' },
  { code: 'ZA', name: 'South Africa', tz: 'Africa/Johannesburg', currency: 'ZAR', money: 'South African rand' },
  { code: 'MY', name: 'Malaysia', tz: 'Asia/Kuala_Lumpur', currency: 'MYR', money: 'Malaysian ringgit' },
  { code: 'SG', name: 'Singapore', tz: 'Asia/Singapore', currency: 'SGD', money: 'Singapore dollars' },
  { code: 'ID', name: 'Indonesia', tz: 'Asia/Jakarta', currency: 'IDR', money: 'Indonesian rupiah' },
  { code: 'OTHER', name: 'Somewhere else', tz: 'UTC', currency: 'USD', money: 'US dollars' },
];
const byCode = (c) => COUNTRIES.find((x) => x.code === String(c || '').toUpperCase()) || null;
module.exports = { COUNTRIES, byCode };
