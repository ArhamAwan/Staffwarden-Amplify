'use strict';
// The currencies people can be paid in, and how an amount is written. Shared by the server and (as a copy
// in web/js/util.js) the website. Amounts are whole units: "$ 2,500", "£ 1,800", "Rs 120,000".
const CURRENCIES = [
  ['USD', '$', 'US dollars'], ['EUR', '€', 'euros'], ['GBP', '£', 'British pounds'], ['CAD', 'CA$', 'Canadian dollars'], ['AUD', 'A$', 'Australian dollars'],
  ['AED', 'AED', 'UAE dirhams'], ['SAR', 'SAR', 'Saudi riyals'], ['QAR', 'QAR', 'Qatari riyals'], ['INR', '₹', 'Indian rupees'], ['PKR', 'Rs', 'Pakistani rupees'],
  ['BDT', 'Tk', 'Bangladeshi taka'], ['PHP', '₱', 'Philippine pesos'], ['MYR', 'RM', 'Malaysian ringgit'], ['SGD', 'S$', 'Singapore dollars'], ['IDR', 'Rp', 'Indonesian rupiah'],
  ['TRY', '₺', 'Turkish lira'], ['EGP', 'E£', 'Egyptian pounds'], ['NGN', '₦', 'Nigerian naira'], ['KES', 'KSh', 'Kenyan shillings'], ['ZAR', 'R', 'South African rand'],
].map(([code, sign, name]) => ({ code, sign, name }));
const BY = Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));
const validCurrency = (c) => Object.prototype.hasOwnProperty.call(BY, String(c || ''));
const signOf = (c) => (BY[c] ? BY[c].sign : String(c || '$'));
const fmtMoney = (n, cur) => `${signOf(cur)} ${Math.abs(Math.round(n || 0)).toLocaleString('en-US')}`;
module.exports = { CURRENCIES, validCurrency, signOf, fmtMoney };
