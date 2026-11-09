'use strict';
// Public holidays a company can add in one go. Dates on or after today are added; days already on the
// calendar are left as they are. Islamic holidays move with the moon: those marked (expected) are the
// expected dates, and the owner moves them once the government announces the final ones.
const LISTS = {
  PK: {
    name: 'Pakistan',
    days: [
      ['2026-11-09', 'Iqbal Day'], ['2026-12-25', 'Quaid-e-Azam Day'],
      ['2027-02-05', 'Kashmir Day'],
      ['2027-03-10', 'Eid ul Fitr (expected)'], ['2027-03-11', 'Eid ul Fitr (expected)'], ['2027-03-12', 'Eid ul Fitr (expected)'],
      ['2027-03-23', 'Pakistan Day'], ['2027-05-01', 'Labour Day'],
      ['2027-05-17', 'Eid ul Adha (expected)'], ['2027-05-18', 'Eid ul Adha (expected)'], ['2027-05-19', 'Eid ul Adha (expected)'],
      ['2027-05-28', 'Youm-e-Takbeer'],
      ['2027-06-14', 'Ashura (expected)'], ['2027-06-15', 'Ashura (expected)'],
      ['2027-08-14', 'Independence Day'], ['2027-08-15', 'Eid Milad un Nabi (expected)'],
      ['2027-11-09', 'Iqbal Day'], ['2027-12-25', 'Quaid-e-Azam Day'],
    ],
  },
  US: {
    name: 'United States',
    // federal holidays, on the day they are observed (a Saturday one on the Friday, a Sunday one on the Monday)
    days: [
      ['2026-11-11', 'Veterans Day'], ['2026-11-26', 'Thanksgiving'], ['2026-12-25', 'Christmas Day'],
      ['2027-01-01', 'New Year’s Day'], ['2027-01-18', 'Martin Luther King Jr. Day'], ['2027-02-15', 'Presidents’ Day'],
      ['2027-05-31', 'Memorial Day'], ['2027-06-18', 'Juneteenth (observed)'], ['2027-07-05', 'Independence Day (observed)'],
      ['2027-09-06', 'Labor Day'], ['2027-10-11', 'Columbus Day'], ['2027-11-11', 'Veterans Day'],
      ['2027-11-25', 'Thanksgiving'], ['2027-12-24', 'Christmas Day (observed)'],
    ],
  },
};
module.exports = { LISTS };
