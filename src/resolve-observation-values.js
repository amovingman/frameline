'use strict';

// Inputs are validated observations. Keep every represented decimal digit;
// binary floating-point conversion would erase some observable differences.
function decimalIdentity(value) {
  if (!value || typeof value !== 'object' || typeof value.decimal !== 'string') return null;
  const [mantissa, scale] = value.decimal.split('e');
  let digits = mantissa.replace(/[-.]/g, '').replace(/^0+/, ''), exponent = Number(scale) - 16;
  if (!digits) return '0';
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  return `${mantissa.startsWith('-') ? '-' : ''}${digits}e${exponent}`;
}
function comparable(value) {
  const decimal = decimalIdentity(value);
  if (decimal !== null) return { decimal };
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, comparable(value[key])]));
  return value;
}
const equivalentObservationValue = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
module.exports = { decimalIdentity, equivalentObservationValue };
