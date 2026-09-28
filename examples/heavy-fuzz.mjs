import { Replica, computeCheckpoint } from '../src/crdt.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}
const r = rng(7);

let peers = [1, 2, 3, 4, 5].map((i) => new Replica('r' + i));
peers[0].appendText('init');
peers.forEach((x, i) => { if (i) x.pullFrom(peers[0]); });

for (let round = 0; round < 40; round++) {
  for (const p of peers) {
    const t = p.text();
    if (r() < 0.6) {
      p.insertText(Math.floor(r() * (t.length + 1)),
        String.fromCharCode(97 + Math.floor(r() * 5)));
    } else if (t.length > 1) {
      p.deleteText(Math.floor(r() * t.length), 1);
    }
  }
  for (const s of peers) {
    for (const d of peers) {
      if (s !== d && r() < 0.3) {
        for (const op of s.opsSince(d.versionVector())) {
          if (r() < 0.8) d.receive(op);
        }
      }
    }
  }
  if (round === 15) peers = peers.map((p) => Replica.fromJSON(p.toJSON()));
  if (round === 25) {
    for (let k = 0; k < 4; k++) for (const x of peers) for (const y of peers) x.sync(y);
    const cp = computeCheckpoint(peers, ['r1', 'r2', 'r3', 'r4', 'r5']);
    const before = peers.map((p) => p.text());
    if (new Set(before).size !== 1) throw new Error('not converged before compact');
    const removed = peers.map((p) => p.compact(cp).removed);
    if (new Set(peers.map((p) => p.text())).size !== 1) throw new Error('diverged at compact');
    peers.forEach((p, i) => { if (p.text() !== before[i]) throw new Error('compact changed text'); });
    console.log('compact removed per replica:', removed.join(','));
  }
}

for (let k = 0; k < 6; k++) for (const x of peers) for (const y of peers) x.sync(y);
const texts = peers.map((p) => p.text());
console.log('final len:', texts[0].length, 'all equal:', new Set(texts).size === 1);
if (new Set(texts).size !== 1) { console.log(texts); process.exit(1); }
console.log('HEAVY FUZZ OK');
