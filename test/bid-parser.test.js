// Pull the parser out of server.js and run it against real inbox text.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const grab = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
};
const code = [ 'normBidAmount', 'stripQuotedReply', 'isDisqualifiedAmount', 'isRateAmount', 'parseBidFromBody' ].map(grab).join('\n')
  + '\nconst BID_CUE = ' + src.match(/const BID_CUE = (\/.*\/i);/)[1] + ';\n';
eval(code);

const CASES = [
  // --- MUST CATCH (real replies now sitting unlogged) ---
  { want: 8000, label: "J'S ONE STOP — 'bid it at 8k'",
    t: "Logan after reviewing the plans\n\nI can bid it at 8k\n\n1 bath\n1 laundry room\n1 kitchen\n\nUnderground, rough and finish installation.\n\nNo utilities\n\nLet me know if this is a good price we can close on" },
  { want: 195000, label: 'MORGAN J P — itemised ADU + lot prep',
    t: "Hi Logan\n497 sq ft ADU= $195,000\nLot prep and Utility hookup= $35,000\nWorkers Comp policy and GL available after price verbal agreement. We serve all\n\n*Jon Morgan*\n*JP Morgan Const. Inc.*\n*CSLB 925035 *\n* 619-719-8358*" },
  { want: 264635, label: 'VALINOR — "estimator came up to"',
    t: "Hey, good morning Logan.  My estimator came up to $264,635.  Is this a budget that works for you? If so, please let me know, and I'll have the contract drawn up." },

  // --- MUST NOT CATCH ---
  { want: null, label: 'LOHR FRED — $300/sq ft is a RATE not a total', rate: 300,
    t: "He Logan. Listen we are at $300 a sq ft. Turn key. I can safely do it for that price. I know good subs here, we get it done." },
  { want: null, label: 'Insurance COI reply',
    t: "Attached: General liability COI (Spinnaker Insurance Co., $1,000,000/$2,000,000 limits, current through 6/17/2027). Each occurrence $1,000,000." },
  { want: null, label: 'Phone + license only, no bid',
    t: "Hi Logan, thanks for the bid request. Call me at 619-719-8358. CSLB 925035. I will review the plans." },
  { want: null, label: 'Scheduling reply with no number',
    t: "Re: bid request — Hi Logan, I got your email about the bid request. I will look over the information and let you know if I have any questions. Thanks" },
  { want: null, label: 'Quoted chain — our own numbers must be ignored',
    t: "Sounds good, I'll review.\n\nOn Aug 12, 2026, at 9:30 AM, logan@buildoly.com wrote:\n> Our budget for the bid is $250,000\n> proposal due August 13" },
  { want: null, label: 'Decline',
    t: "Hi Logan, Unfortunately at this time we will be unable to bid on your projects. This is mainly due to the pricing." },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const r = parseBidFromBody(c.t);
  const got = r ? r.amount : null;
  const gotRate = r ? r.rate : null;
  let ok = (got === c.want);
  if (c.rate) ok = ok && gotRate === c.rate;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + c.label + '  → amount=' + got + (gotRate ? ' rate=' + gotRate : '') + (ok ? '' : '   (wanted ' + c.want + (c.rate ? ' / rate ' + c.rate : '') + ')'));
  ok ? pass++ : fail++;
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
